#!/usr/bin/env node
/**
 * VERIFY: TWO STORES, ONE SHOP.
 *
 * `server/db.js` became a contract with two implementations behind it, and the
 * whole value of that seam is a claim nobody can check by playing: that a shop
 * kept in SQLite and a shop kept in a browser are the *same shop*. Everything
 * here is a comparison rather than a value, because a value would only tell you
 * what one store does.
 *
 * The reason this is a sweep and not a unit test is the failure mode. The sim
 * reads the store through nineteen functions and nothing else, so a web store
 * that is subtly wrong does not crash — it hands back a catalogue with a field
 * missing, or a modifier list that keeps a row a day longer, and what you get is
 * a shop that plays *slightly differently in a browser* with nothing anywhere to
 * say so. Every claim below is therefore run against both stores in the same
 * breath and diffed.
 *
 * Its centrepiece is the one nobody would think to write: **the same rows.**
 * SQLite's come out of a database seeded from `data/seed/*.json`; the web
 * store's are that same file, imported. Those two ought to be identical and
 * there are three ways they are not — the export strips bookkeeping columns, the
 * seed path puts every row through zod on the way in, and SQLite stores a
 * boolean as an integer. Any one of them is a field that quietly differs in one
 * build, which is the class of bug that ends up being reported as "the browser
 * version feels wrong".
 *
 * The other one worth naming is **durability**, which is the only claim here
 * about something that has not happened yet: writes reach memory synchronously
 * and the vault afterwards, so the test is not "did it write" but "is it there
 * after everything was thrown away and read back". A vault that silently drops
 * writes looks perfect for the whole of a session and loses your shop when you
 * close the tab.
 *
 * Writes nothing anywhere near the live database: it seeds a throwaway SQLite
 * file under the OS temp dir via SNS_DB and removes it on exit, and the web
 * store runs on `memoryVault()`.
 *
 *   node scripts/verify-store.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// BEFORE any import that reaches the store: `DB_PATH` is read once, at module
// load. Set it late and the sweep seeds the shop somebody is playing.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-store-'));
process.env.SNS_DB = path.join(TMP, 'verify.db');

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/** Key order is not a fact about the data, so it must not be a fact about the diff. */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  }
  return v;
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** Run one function against both stores and insist they answered alike. */
function both(label, fn) {
  let a; let b;
  let aThrew = null; let bThrew = null;
  try { a = fn(sqlite); } catch (err) { aThrew = err.message; }
  try { b = fn(web); } catch (err) { bThrew = err.message; }
  check(!!aThrew === !!bThrew, `${label}: one store threw and the other did not`,
    `sqlite: ${aThrew ?? 'ok'} / web: ${bThrew ?? 'ok'}`);
  if (aThrew || bThrew) return [a, b];
  check(same(a, b), `${label}: the two stores disagree`,
    `sqlite: ${JSON.stringify(canon(a))?.slice(0, 300)} / web: ${JSON.stringify(canon(b))?.slice(0, 300)}`);
  return [a, b];
}

// ---------------------------------------------------------------------------

const sqlite = await import('../server/store/sqlite.js');
const web = await import('../server/store/web.js');
const { writeContent, refresh } = await import('../server/content.js');

const TABLES = ['items', 'crops', 'archetypes', 'events', 'upgrades', 'recipes',
  'fixtures', 'workers', 'pastimes', 'skins', 'vehicles', 'kits'];

// Seed the throwaway database exactly the way `npm run seed` does — through
// `writeContent`, so the rows land validated, which is the only way the
// comparison below is asking the real question.
const FILES = [
  ['items.json', 'item'], ['crops.json', 'crop'], ['archetypes.json', 'archetype'],
  ['events.json', 'event'], ['upgrades.json', 'upgrade'], ['recipes.json', 'recipe'],
  ['fixtures.json', 'fixture'], ['workers.json', 'worker'], ['pastimes.json', 'pastime'],
  ['vehicles.json', 'vehicle'], ['skins.json', 'skin'], ['kits.json', 'kit'],
];
sqlite.db();
let seeded = 0;
for (const [file, kind] of FILES) {
  const p = path.join(sqlite.SEED_DIR, file);
  if (!fs.existsSync(p)) continue;
  for (const row of JSON.parse(fs.readFileSync(p, 'utf8'))) {
    const res = writeContent(kind, row, 'seed');
    if (!res.ok) failures.push(`seeding ${kind} "${row.id}": ${res.error}`);
    else seeded++;
  }
  refresh();
}

await web.openStore(web.memoryVault());

// ---- 1. the same rows -----------------------------------------------------
//
// Bookkeeping is excluded on purpose and nothing else is. `created_at` is a
// clock and `created_by` says which process wrote it — neither is read by any
// mechanic, and the export strips both, so insisting on them would be asserting
// that a browser knows what time a row was authored on somebody else's laptop.

const strip = (row) => {
  const { created_at: _a, created_by: _b, ...rest } = row;
  return rest;
};

for (const table of TABLES) {
  const a = sqlite.all(table).map(strip).sort((x, y) => String(x.id).localeCompare(String(y.id)));
  const b = web.all(table).map(strip).sort((x, y) => String(x.id).localeCompare(String(y.id)));
  eq(b.length, a.length, `${table}: row count`);
  eq(b.map((r) => r.id).join(','), a.map((r) => r.id).join(','), `${table}: the same ids`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (!same(a[i], b[i])) {
      // Name the fields rather than dumping two rows: a fixture row is 6KB of
      // model and the difference is one boolean.
      const keys = [...new Set([...Object.keys(a[i]), ...Object.keys(b[i])])];
      const off = keys.filter((k) => !same(a[i][k], b[i][k]));
      check(false, `${table} "${a[i].id}": fields differ`, off.join(', '));
    } else checks++;
  }
}

// A row read one at a time is the row read in bulk. `get` is the one contract
// function `content.js` never calls, which makes it the one most likely to be
// wrong and least likely to be noticed.
for (const table of TABLES) {
  const id = sqlite.all(table)[0]?.id;
  if (!id) continue;
  check(same(strip(sqlite.get(table, id) ?? {}), strip(web.get(table, id) ?? {})),
    `${table}: get("${id}") matches all()`);
  both(`${table}: get of something that isn't there`, (s) => s.get(table, 'zz-no-such-row'));
}

// ---- 2. the registry version ----------------------------------------------

const v1 = web.contentVersion();
const v2 = web.contentVersion();
eq(v2, v1, 'web: contentVersion does not move on its own');
const sv1 = sqlite.contentVersion();
writeContent('item', { ...JSON.parse(fs.readFileSync(path.join(sqlite.SEED_DIR, 'items.json'), 'utf8'))[0], id: 'zz-store-probe' }, 'verify');
check(sqlite.contentVersion() > sv1, 'sqlite: contentVersion moves on a write');
eq(web.contentVersion(), v1, 'web: contentVersion still has not moved');
sqlite.remove('items', 'zz-store-probe');

// ---- 3. the two refusals ---------------------------------------------------
//
// The claim is that they THROW, not that they no-op. A write that quietly
// succeeds into memory is a row that is in the registry, plays correctly, and is
// gone on reload with an authoring session inside it.

let threw = false;
try { web.upsert('items', { id: 'zz-nope' }); } catch { threw = true; }
check(threw, 'web: upsert refuses');
threw = false;
try { web.remove('items', 'zz-nope'); } catch { threw = true; }
check(threw, 'web: remove refuses');

// ---- 4. save slots ---------------------------------------------------------

both('no worlds to begin with', (s) => s.listWorldRows().length);
both('a world that does not exist', (s) => s.worldRow('shop-a'));

both('insert a world', (s) => {
  const r = s.insertWorldRow({ id: 'shop-a', name: 'First', seed: 'seed-a' });
  return { id: r.id, name: r.name, seed: r.seed };
});
// A real gap between the two, because `played_at` is what the menu sorts by and
// two rows written inside one millisecond are a TIE — which SQLite breaks by
// whatever its sort happened to do and an array breaks by staying stable. That
// is unspecified on both sides rather than a disagreement worth asserting, and a
// sweep that pins it would fail on a fast morning and pass on a slow one.
await new Promise((r) => setTimeout(r, 5));
both('insert a second', (s) => {
  const r = s.insertWorldRow({ id: 'shop-b', name: 'Second', seed: 7 });
  // Numbers become strings on the way in — a seed is a *name* for an rng
  // stream, and one store coercing where the other does not is two different
  // worlds off one number.
  return { seed: r.seed, type: typeof r.seed };
});
both('list them', (s) => s.listWorldRows().map((r) => ({ id: r.id, name: r.name, seed: r.seed })));
both('rename one', (s) => s.renameWorldRow('shop-a', 'Renamed').name);
both('rename one that is not there', (s) => s.renameWorldRow('shop-zz', 'Nope'));
both('read one back', (s) => { const r = s.worldRow('shop-b'); return { id: r.id, name: r.name }; });
both('touch one that is not there', (s) => s.touchWorldRow('shop-zz') ?? null);

// The menu sorts by `played_at`, so the order is the feature rather than a
// detail of the query. Touching the older one has to bring it to the front in
// both stores, and a shared clock would hide a store that never wrote the field.
await new Promise((r) => setTimeout(r, 5));
both('touching a world moves it to the front', (s) => {
  s.touchWorldRow('shop-a');
  return s.listWorldRows().map((r) => r.id);
});

// ---- 5. the save blob ------------------------------------------------------

both('a save that was never written', (s) => s.getWorld(s.worldStateKey('shop-a'), null));
both('a save that was never written, with a fallback', (s) => s.getWorld('nothing:here', { hi: 1 }));
both('write a save', (s) => s.setWorld(s.worldStateKey('shop-a'), { day: 3, cash: 12.5, ownedUpgrades: ['a'] }));
both('read it back', (s) => s.getWorld(s.worldStateKey('shop-a')));
both('overwrite it', (s) => {
  s.setWorld(s.worldStateKey('shop-a'), { day: 4, cash: 0, ownedUpgrades: [] });
  return s.getWorld(s.worldStateKey('shop-a'));
});

// What comes out must not be a handle on what is kept. `world()` learned this
// the expensive way about `DEFAULT_WORLD` — a shallow copy handed out the
// module's own array and `buyUpgrade` pushed onto it, so every balance run in a
// process started richer than the last.
both('a save handed out is a copy', (s) => {
  const got = s.getWorld(s.worldStateKey('shop-a'));
  got.ownedUpgrades.push('scribbled');
  got.day = 999;
  return s.getWorld(s.worldStateKey('shop-a'));
});
both('a save handed IN is a copy too', (s) => {
  const mine = { day: 5, tags: ['x'] };
  s.setWorld(s.worldStateKey('shop-b'), mine);
  mine.tags.push('after');
  mine.day = 999;
  return s.getWorld(s.worldStateKey('shop-b'));
});

// ---- 6. modifiers ----------------------------------------------------------

const MOD = { source: 'director', label: 'Heat wave', tag: 'frozen', demand_mult: 1.4, price_mult: 1.1, expires_day: 5 };
both('no modifiers yet', (s) => s.activeModifiers(0, 'shop-a'));
both('add one', (s) => s.addModifier({ worldId: 'shop-a', ...MOD }));
both('the identical row again is not a second event', (s) => s.addModifier({ worldId: 'shop-a', ...MOD }));
both('one that differs in any value is', (s) => s.addModifier({ worldId: 'shop-a', ...MOD, demand_mult: 1.5 }));
both('a modifier is scoped to its world', (s) => {
  s.addModifier({ worldId: 'shop-b', ...MOD, tag: 'produce' });
  return {
    a: s.activeModifiers(0, 'shop-a').map((m) => `${m.tag}:${m.demand_mult}`).sort(),
    b: s.activeModifiers(0, 'shop-b').map((m) => `${m.tag}:${m.demand_mult}`).sort(),
  };
});
both('expiry is strictly greater than the day', (s) => ({
  onDayFour: s.activeModifiers(4, 'shop-a').length,
  onDayFive: s.activeModifiers(5, 'shop-a').length,
}));
both('prune takes the expired ones only', (s) => ({
  gone: s.pruneModifiers(5, 'shop-a'),
  left: s.activeModifiers(0, 'shop-a').length,
  otherWorld: s.activeModifiers(0, 'shop-b').length,
}));
both('clear by source', (s) => {
  s.addModifier({ worldId: 'shop-a', ...MOD, source: 'manual', expires_day: 9 });
  s.addModifier({ worldId: 'shop-a', ...MOD, source: 'director', expires_day: 9 });
  return { cleared: s.clearModifiers('manual', 'shop-a'), left: s.activeModifiers(0, 'shop-a').length };
});
both('clear everything in one world', (s) => ({
  cleared: s.clearModifiers(null, 'shop-a'),
  left: s.activeModifiers(0, 'shop-a').length,
  otherWorld: s.activeModifiers(0, 'shop-b').length,
}));

// ---- 7. deleting a world takes its things and nothing else -----------------

both('delete a world', (s) => {
  s.addModifier({ worldId: 'shop-a', ...MOD, expires_day: 40 });
  s.setWorld(s.worldStateKey('shop-a'), { day: 8 });
  const had = s.deleteWorldRow('shop-a');
  return {
    had,
    row: s.worldRow('shop-a'),
    save: s.getWorld(s.worldStateKey('shop-a'), 'gone'),
    itsModifiers: s.activeModifiers(0, 'shop-a').length,
    theOtherWorldSurvives: !!s.worldRow('shop-b'),
    itsSaveSurvives: s.getWorld(s.worldStateKey('shop-b'), null) !== null,
    itsModifiersSurvive: s.activeModifiers(0, 'shop-b').length,
  };
});
both('delete one that is not there', (s) => s.deleteWorldRow('shop-zz'));
both('content is untouched by any of it', (s) => TABLES.map((t) => s.all(t).length).join(','));

// ---- 8. durability ---------------------------------------------------------
//
// The only claim here about a thing that has not happened yet. Everything above
// passes against a store that never writes to its vault at all.

const vault = web.memoryVault();
await web.openStore(vault);
web.insertWorldRow({ id: 'keep-me', name: 'Persisted', seed: 'p' });
web.setWorld(web.worldStateKey('keep-me'), { day: 12, cash: 99.5, ledger: [{ day: 11, profit: 3 }] });
web.addModifier({ worldId: 'keep-me', ...MOD });
await web.flushStore();

// Throw the whole store away and read the vault back, which is what closing the
// tab and opening it tomorrow does.
web.resetStore();
eq(web.worldRow('keep-me'), null, 'reset really did empty it');
const reopened = await web.openStore(vault);
eq(reopened.worlds, 1, 'the world came back');
eq(web.worldRow('keep-me')?.name, 'Persisted', 'with its name');
eq(web.getWorld(web.worldStateKey('keep-me'))?.cash, 99.5, 'the save came back');
eq(web.getWorld(web.worldStateKey('keep-me'))?.ledger?.[0]?.profit, 3, 'and its nested rows');
eq(web.activeModifiers(0, 'keep-me').length, 1, 'the modifiers came back');

// A delete has to reach the vault too, or a world you threw away is back
// tomorrow — the one failure that looks like the game resurrecting a save.
web.deleteWorldRow('keep-me');
await web.flushStore();
web.resetStore();
await web.openStore(vault);
eq(web.worldRow('keep-me'), null, 'a deleted world stays deleted across a reload');
eq(web.getWorld(web.worldStateKey('keep-me'), 'gone'), 'gone', 'and so does its save');
eq(web.activeModifiers(0, 'keep-me').length, 0, 'and its modifiers');

// Ids keep climbing across a reload. They are AUTOINCREMENT on one side, so a
// counter that restarted at 1 would hand a second modifier the id of a first.
web.addModifier({ worldId: 'w', ...MOD, expires_day: 3 });
await web.flushStore();
const before = web.activeModifiers(0, 'w')[0].id;
web.resetStore();
await web.openStore(vault);
web.addModifier({ worldId: 'w', ...MOD, expires_day: 4 });
const ids = web.activeModifiers(0, 'w').map((m) => m.id);
check(new Set(ids).size === ids.length, 'modifier ids stay unique across a reload', `got ${ids.join(', ')}`);
check(Math.max(...ids) > before, 'and keep climbing');

// ---------------------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\nverify:store — ${checks} assertions, ${seeded} rows seeded`);
if (failures.length) {
  console.log(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures.slice(0, 40)) console.log(`      ${f}`);
  if (failures.length > 40) console.log(`      … and ${failures.length - 40} more`);
  console.log('');
  process.exit(1);
}
console.log('\n  ✅  a shop kept in SQLite and a shop kept in a browser are the same shop.\n');
