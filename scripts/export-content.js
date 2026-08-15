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
import { SEED_DIR, all } from '../server/db.js';

/** Columns that are bookkeeping, not content — stripped so diffs stay clean. */
const STRIP = ['created_by', 'created_at'];

const EXPORTS = [
  ['items.json', 'items'],
  ['crops.json', 'crops'],
  ['archetypes.json', 'archetypes'],
  ['events.json', 'events'],
  ['upgrades.json', 'upgrades'],
  ['recipes.json', 'recipes'],
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
