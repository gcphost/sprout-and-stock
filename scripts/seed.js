/**
 * Load data/seed/*.json into the SQLite DB.
 *
 * Safe to re-run: rows are upserted by id. Existing live edits to a row WILL
 * be overwritten by the seed version, which is what you want when you're
 * pulling someone else's committed content.
 *
 *   npm run seed
 */

import fs from 'node:fs';
import path from 'node:path';
// Both are SQLite's own — a directory on disk and the handle that opens it.
// Seeding is a thing you do to a database, so it asks the store that is one.
import { SEED_DIR, db } from '../server/store/sqlite.js';
import { writeContent, refresh } from '../server/content.js';

const FILES = [
  // Order matters: crops reference items, and recipes reference both their
  // ingredients and their output item.
  ['items.json', 'item'],
  ['crops.json', 'crop'],
  ['archetypes.json', 'archetype'],
  ['events.json', 'event'],
  ['upgrades.json', 'upgrade'],
  ['recipes.json', 'recipe'],
  ['fixtures.json', 'fixture'],
  ['workers.json', 'worker'],
  ['pastimes.json', 'pastime'],
  ['vehicles.json', 'vehicle'],
  // After workers, though nothing enforces it: a skin references no worker kind
  // and a worker references no skin, which is the whole reason one skin fits
  // every kind. The order here is only so the file list reads in the order the
  // things were built.
  ['skins.json', 'skin'],
  // Last, and like skins the order is only how it reads: a kit names no
  // archetype and an archetype names no kit — they meet through tags, which is
  // exactly what stops either one having to exist before the other.
  ['kits.json', 'kit'],
];

let ok = 0;
let failed = 0;
const problems = [];

db();

for (const [file, kind] of FILES) {
  const p = path.join(SEED_DIR, file);
  if (!fs.existsSync(p)) {
    console.log(`  skip ${file} (not found)`);
    continue;
  }
  const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const row of rows) {
    const res = writeContent(kind, row, 'seed');
    if (res.ok) {
      ok++;
      for (const w of res.warnings) problems.push(`  warn  ${kind} "${row.id}": ${w}`);
    } else {
      failed++;
      problems.push(`  FAIL  ${kind} "${row.id ?? '?'}": ${res.error}`);
    }
  }
  refresh();
  console.log(`  ${file.padEnd(18)} ${rows.length} rows`);
}

if (problems.length) {
  console.log('');
  for (const p of problems) console.log(p);
}

console.log(`\nSeeded ${ok} rows${failed ? `, ${failed} FAILED` : ''}.`);
process.exit(failed ? 1 : 0);
