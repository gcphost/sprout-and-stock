/**
 * Put the money back to day one without throwing anything away.
 *
 *   npm run reset:economy                  cash, day, season, reputation, modifiers
 *   npm run reset:economy -- --all         also the shop you built: upgrades, staff,
 *                                          fixtures, placements, walls
 *
 * `--all` keeps the slot's seed, where it used to reset that too. A seed is the
 * shape of the shop, and now that a save has a name on it in the menu, coming
 * back to a differently-shaped building called "Corner Shop" is not a reset — it is
 * a different shop. Delete the world from the menu if that is what you wanted.
 *   npm run reset:economy -- --world=<id>  which save slot. Defaults to the one
 *                                          played most recently; `--list` shows them.
 *
 * `npm run reset` deletes the database, which takes every item, crop, worker
 * and fixture you authored live and never exported with it. This only rewrites
 * the runtime save (the `world` table) and empties the modifier table, so all
 * content survives either way.
 *
 * The default mode is also available live, without stopping anything, as the
 * `reset_economy` MCP tool. `--all` deliberately isn't: tearing the roster and
 * the fixture ledger out from under a running room is a different operation.
 *
 * WHAT GETS RESET IS AN ALLOW-LIST, NOT A KEEP-LIST — see `ECONOMY_KEYS` in
 * content.js, which both this and the live route read, so they can't drift.
 */

import { listWorldRows, worldRow, clearModifiers } from '../server/db.js';
import { DEFAULT_WORLD, freshEconomy, world as loadWorld, saveWorld } from '../server/content.js';

const all = process.argv.includes('--all');
const PORT = Number(process.env.PORT ?? 2567);

const rows = listWorldRows();
if (process.argv.includes('--list')) {
  for (const r of rows) console.log(`${r.id.padEnd(24)} ${r.name}`);
  process.exit(0);
}

// Rows come back most-recently-played first, so the bare command means the shop
// you were last in. Naming one is how you reset the other.
const asked = process.argv.find((a) => a.startsWith('--world='))?.slice('--world='.length);
const target = asked ?? rows[0]?.id;
if (!target) {
  console.error('There are no worlds in this database. Start the server once, or run `npm run seed`.');
  process.exit(1);
}
if (!worldRow(target)) {
  console.error(`No world "${target}". Try one of: ${rows.map((r) => r.id).join(', ') || '(none)'}`);
  process.exit(1);
}

// A running room holds the Game in memory and persists it on the next tick, so
// a reset underneath it looks like it silently did nothing. Refuse instead.
try {
  const res = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(500) });
  if (res.ok) {
    console.error(`A game server is live on :${PORT}. Stop it first — it would persist the old save straight back over this.`);
    process.exit(1);
  }
} catch {
  // Nothing listening, which is exactly what we want.
}

const before = loadWorld(target);

const after = all
  ? { ...DEFAULT_WORLD, seed: before.seed }
  : {
      ...before,
      ...freshEconomy(),
      // The director's "already spoke today" guard. Left pointing at day 40 it
      // would sit out the whole first week of the new run.
      lastDirectorDay: null,
    };

saveWorld(target, after);
const cleared = clearModifiers(undefined, target);

const money = (n) => `$${Number(n ?? 0).toFixed(2)}`;
console.log(`world       ${target}`);
console.log(`cash        ${money(before.cash)} → ${money(after.cash)}`);
console.log(`day         ${before.day ?? '?'} → ${after.day}`);
console.log(`season      ${before.season ?? '?'} → ${after.season}`);
console.log(`reputation  ${before.reputation ?? '?'} → ${after.reputation}`);
console.log(`modifiers   ${cleared} cleared`);
console.log(all
  ? '\nFull wipe: upgrades, staff, fixtures and walls are back to defaults. Content untouched.'
  : `\nKept: ${(before.ownedUpgrades ?? []).length} upgrade(s), ${(before.roster ?? []).length} staff, `
    + `${(before.placements ?? []).length} placed fixture(s). Content untouched.`);
