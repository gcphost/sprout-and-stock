/**
 * SERVER ENTRY POINT.
 *
 * Runs three things in one process:
 *   1. The Colyseus game server (websockets, rooms, the simulation).
 *   2. The HTTP control API that MCP drives (/api/*).
 *   3. In production, the built client as static files.
 *
 * In dev, Vite serves the client separately on :5173 and proxies /api and the
 * websocket here — so `npm run dev` gives you HMR on the client and
 * `node --watch` restarts on the server, with Colyseus devMode preserving the
 * room state across those restarts.
 */

import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';

import { MartRoom } from './rooms/MartRoom.js';
import { createApi } from './api.js';
// The boot handle, straight from the SQLite store rather than through
// `db.js` — opening a file is not part of the store contract, and a build with
// no file has no boot step to put this in. See the note in server/db.js.
import { db } from './store/sqlite.js';
import { refresh, content } from './content.js';
import { ensureAWorld, listWorlds } from './worlds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 2567);
const DEV = process.env.NODE_ENV !== 'production';

// Boot the DB and content registry before anything can ask for them.
db();
refresh();

if (content().items.length === 0) {
  console.warn('\n⚠️  No content in the database. Run `npm run seed` first.\n');
}

// A database that has never been played gets its first save slot here rather
// than on the first join. Once only, marked on the save: deleting every shop is
// allowed, and a boot that refilled the menu would take it straight back.
ensureAWorld();

const app = express();

// The client fetches this to discover where the game server lives — which
// matters once you're behind a tunnel and the origin isn't localhost.
app.get('/api/config', (req, res) => {
  res.json({ ok: true, port: PORT, dev: DEV });
});

app.use('/api', createApi());

// In production, serve the built client.
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  // devMode caches room state to disk on shutdown and restores it on boot, so
  // editing a server file doesn't wipe the shop you were standing in.
  devMode: DEV,
});

// One room per world, matched on the id. Without `filterBy`, `joinOrCreate`
// hands you whichever `mart` room already exists and every save slot in the
// menu quietly opens the same shop.
gameServer.define('mart', MartRoom).filterBy(['worldId']);

await gameServer.listen(PORT);

console.log(`\n  ⚙️  Sprocket & Stock`);
console.log(`  game server  ws://localhost:${PORT}`);
console.log(`  control api  http://localhost:${PORT}/api/health`);
if (DEV) console.log(`  client       http://localhost:5173  (npm run dev)`);
console.log(`  content      ${content().items.length} items, ${content().crops.length} crops, ${content().archetypes.length} archetypes`);
console.log(`  worlds       ${listWorlds().map((w) => `${w.name} (${w.id}, day ${w.day})`).join(', ')}`);
console.log(`  director     built-in events`);
console.log('');

/**
 * Shutting down is COLYSEUS'S JOB, and asking for it a second time cost us the
 * whole of devMode.
 *
 * `new Server()` already registers SIGINT/SIGTERM (`registerGracefulShutdown`),
 * and that handler is the one that ends with `presence.shutdown()` — the line
 * that writes `.devmode.json`. A second handler here raced it: whichever call
 * arrived second got `already_shutting_down`, which `gracefullyShutdown`
 * *catches* and then follows with `process.exit(0)` in its `finally`. So the
 * duplicate reliably killed the process mid-shutdown, before the cache was
 * written. Measured: no `.devmode.json` at all, and one line of
 * `error during shutdown: already_shutting_down` in the log to say so — which
 * reads as a shutdown wrinkle rather than as the reason every restart put you
 * back at the door with empty hands.
 *
 * A log line is all we ever wanted from it, and there is a hook for that which
 * runs *inside* the one shutdown instead of starting a second one.
 */
gameServer.onBeforeShutdown(() => {
  console.log('\nshutting down…');
  return Promise.resolve();
});
