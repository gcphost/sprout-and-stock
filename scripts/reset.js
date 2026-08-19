/**
 * Nuke the live DB and reseed from data/seed/*.json.
 *
 *   npm run reset
 *
 * Use when the world state gets into a silly place, or when you want a clean
 * economy to balance against. Content you added live but never `npm run export`ed
 * is LOST — that's the tradeoff, and why export exists.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from '../server/store/sqlite.js';

const targets = ['game.db', 'game.db-wal', 'game.db-shm'];
let removed = 0;

for (const t of targets) {
  const p = path.join(DATA_DIR, t);
  if (fs.existsSync(p)) {
    fs.rmSync(p);
    removed++;
  }
}

console.log(`Removed ${removed} database file(s). Reseeding…\n`);

execFileSync(process.execPath, [path.join(import.meta.dirname, 'seed.js')], { stdio: 'inherit' });
