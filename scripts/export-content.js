/**
 * Dump the live DB back out to data/seed/*.json so it can be committed.
 *
 * This is how live playground edits become permanent, reviewable history.
 * Run it at the end of a session, then commit the diff:
 *
 *   npm run export && git add data/seed && git commit -m "new content"
 */

import fs from 'node:fs';
import path from 'node:path';
// `all` is the store contract; `SEED_DIR` is a directory on a disk and belongs
// to the store that has one. Two imports rather than one on purpose — this
// script is the bridge between them, which is exactly what it looks like.
import { all } from '../server/db.js';
import { SEED_DIR } from '../server/store/sqlite.js';

/** Columns that are bookkeeping, not content — stripped so diffs stay clean. */
const STRIP = ['created_by', 'created_at'];

const EXPORTS = [
  ['items.json', 'items'],
  ['crops.json', 'crops'],
  ['archetypes.json', 'archetypes'],
  ['events.json', 'events'],
  ['upgrades.json', 'upgrades'],
  ['recipes.json', 'recipes'],
  ['fixtures.json', 'fixtures'],
  ['workers.json', 'workers'],
  ['pastimes.json', 'pastimes'],
  ['vehicles.json', 'vehicles'],
  ['skins.json', 'skins'],
  ['kits.json', 'kits'],
];

fs.mkdirSync(SEED_DIR, { recursive: true });

for (const [file, table] of EXPORTS) {
  const rows = all(table)
    .map((r) => {
      const out = { ...r };
      for (const k of STRIP) delete out[k];
      return out;
    })
    // Stable order so git diffs are readable instead of a reshuffle every time.
    .sort((a, b) => a.id.localeCompare(b.id));

  fs.writeFileSync(path.join(SEED_DIR, file), `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`  ${file.padEnd(18)} ${rows.length} rows`);
}

console.log('\nExported. `git add data/seed` to commit.');
