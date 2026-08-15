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
import { db } from './db.js';
import { refresh, content } from './content.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 2567);
const DEV = process.env.NODE_ENV !== 'production';

// Boot the DB and content registry before anything can ask for them.
db();
refresh();

if (content().items.length === 0) {
  console.warn('\n⚠️  No content in the database. Run `npm run seed` first.\n');
}

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

gameServer.define('mart', MartRoom);

await gameServer.listen(PORT);

console.log(`\n  🌱 Sprout & Stock`);
console.log(`  game server  ws://localhost:${PORT}`);
console.log(`  control api  http://localhost:${PORT}/api/health`);
if (DEV) console.log(`  client       http://localhost:5173  (npm run dev)`);
console.log(`  content      ${content().items.length} items, ${content().crops.length} crops, ${content().archetypes.length} archetypes`);
if (!process.env.ANTHROPIC_API_KEY) {
  console.log(`  director     using built-in events (set ANTHROPIC_API_KEY for AI events)`);
} else {
  console.log(`  director     AI enabled (${process.env.SNS_DIRECTOR_MODEL ?? 'claude-opus-5'})`);
}
console.log('');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\nshutting down…');
    await gameServer.gracefullyShutdown();
    process.exit(0);
  });
}
