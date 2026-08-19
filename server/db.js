/**
 * THE STORE — what the game asks of whatever is keeping its things.
 *
 * Everything in the server imports from here and nothing imports a backend
 * directly, which is the whole of what this file is for. Today there is one
 * implementation ([store/sqlite.js](store/sqlite.js)) and this is a re-export;
 * step 3 of docs/browser.md adds a second, backed by the seed JSON and
 * IndexedDB, swapped in by a bundler alias rather than by a branch at runtime.
 *
 * A re-export rather than an object with methods, for the reason `ShopRoom`
 * is a mixin: the seam has to be a *provable* no-op, and the only diff that
 * proves itself is one where no caller changed. All twenty-six importers of this
 * module are untouched by its having been split.
 *
 * ---
 *
 * THE CONTRACT. Nineteen functions, four groups, and a second store is only
 * honest if it has all of them:
 *
 *   content       all(table), get(table, id), upsert(table, obj), remove(table, id)
 *   the registry  contentVersion()
 *   the save      getWorld(key, fallback), setWorld(key, value), worldStateKey(id)
 *   world rows    listWorldRows(), worldRow(id), insertWorldRow({id, name, seed}),
 *                 touchWorldRow(id), renameWorldRow(id, name), deleteWorldRow(id)
 *   modifiers     activeModifiers(day, worldId), addModifier({...}),
 *                 pruneModifiers(day, worldId), clearModifiers(source, worldId)
 *
 * Three notes about the shape, each of which is a trap for the second
 * implementation rather than a description of this one:
 *
 * - **Everything here is synchronous.** `better-sqlite3` is, and so the whole
 *   server is: `content()` refreshes inside a 250ms timer, `Game.persist` is
 *   called from the middle of a tick, and `world()` is read during
 *   construction. A store whose reads are promises is not this contract with
 *   `async` sprinkled on it — it is a different one, and the work of adopting
 *   it is in the sim rather than here. IndexedDB is async, which is why the web
 *   store has to read itself into memory once at boot and *write* behind the
 *   scenes, never the other way round.
 * - **`upsert` and `remove` may refuse.** A store that cannot author content
 *   must throw rather than succeed into memory. A content write that appears to
 *   work and is gone on reload is the worst failure available here, because the
 *   thing it destroys is somebody's authoring session and nothing logs it.
 * - **`contentVersion` is polled**, every 250ms, by the room. It exists so a
 *   write from *another process* can be noticed. A store with no other process
 *   should return a constant and not a counter — a number that keeps moving
 *   rebuilds the registry for ever, which is invisible and costs a rebuild of
 *   every menu in the game four times a second.
 *
 * WHAT IS DELIBERATELY NOT HERE: `db()`, `DATA_DIR`, `SEED_DIR`. Those are
 * facts about a file on a disk and they live on the SQLite store, where the
 * four Node-only callers that need them (server/index.js, seed, export, reset)
 * import them directly. See the note at the top of store/sqlite.js.
 */

export {
  // content
  all, get, upsert, remove,
  // the registry
  contentVersion,
  // the save
  getWorld, setWorld,
  // world rows
  listWorldRows, worldRow, insertWorldRow, touchWorldRow, renameWorldRow,
  deleteWorldRow,
  // modifiers
  activeModifiers, addModifier, pruneModifiers, clearModifiers,
} from './store/sqlite.js';

// Not storage — the *format* both stores have to agree about. Straight from the
// module that owns them rather than through the backend, so that a second store
// cannot quietly disagree with this one about where a save lives.
export { DEFAULT_WORLD_ID, worldStateKey } from './store/keys.js';
