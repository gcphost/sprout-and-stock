import { defineConfig } from 'vite';
import path from 'node:path';

/**
 * The web build — `npm run build:web` / `npm run dev:web`.
 *
 * Read here as well as in the client because two of the aliases below only
 * apply to it. Everything else is shared, so there is one config rather than
 * two that drift.
 */
const LOCAL = process.env.VITE_SNS_LOCAL === '1';

export default defineConfig({
  root: 'client',
  publicDir: false,
  /**
   * `.env` lives at the repo root, not next to the client.
   *
   * Vite looks for it beside `root` by default, which here is `client/` — so a
   * `VITE_` variable in the obvious place is silently not there, and the symptom
   * is a feature that quietly turns itself off (the broker) rather than an
   * error. One env file, where everything else in the project already is.
   */
  envDir: import.meta.dirname,
  resolve: {
    alias: [
      /**
       * THE STORE SWAP — step 3 of docs/browser.md.
       *
       * Anything bundled for the browser that reaches `server/db.js` gets the
       * web store instead of SQLite. An alias rather than a runtime branch, and
       * that is the whole design: there is no boot order to get wrong, no entry
       * point that has to remember to install a backend, and `better-sqlite3` —
       * a native module with no browser story at all — is never even reached by
       * the bundler, let alone shipped.
       *
       * THE PATTERN MATCHES THE SPECIFIER, NOT THE RESOLVED PATH, which is the
       * one thing to get wrong here and it fails in the least helpful way: the
       * only importer that matters is `server/db.js`, whose specifier is the
       * relative `./store/sqlite.js`, so an alias written against the full
       * `/server/store/sqlite.js` matches nothing at all. The build then gets
       * as far as SQLite and dies on `fileURLToPath` not being exported by
       * `__vite-browser-external` — an error about `node:url` that says nothing
       * whatsoever about an alias.
       *
       * Everything before `store/sqlite.js` is kept so the replacement stays
       * relative to whoever imported it.
       */
      {
        find: /^(.*)store\/sqlite\.js$/,
        replacement: '$1store/web.js',
      },
      /**
       * ...and Colyseus itself, in the web build only.
       *
       * `server/worlds.js` reaches for `matchMaker` in exactly one function, and
       * making that import dynamic was not enough: a dynamic import is still an
       * edge in the module graph, so the bundler followed it into the Node
       * server and died resolving `@pm2/io`. See server/rooms/no-matchmaker.js,
       * which throws rather than no-ops.
       *
       * ANCHORED, and that is not fussiness — a Vite string alias matches by
       * PREFIX, so a bare `'colyseus'` would also capture `'colyseus.js'`, which
       * is the browser client the *server* build's `client/net.js` runs on. That
       * swap would replace the working transport with a stub that throws, in the
       * build that is not even being changed here.
       *
       * Unconditional, both builds. No browser bundle should ever contain the
       * Node `colyseus` — the server build's client talks to it over a socket
       * rather than importing it — so an accidental import is worth a legible
       * throw in either target rather than a working build nobody looks at.
       */
      { find: /^colyseus$/, replacement: path.resolve(import.meta.dirname, 'server/rooms/no-matchmaker.js') },
      /**
       * ...and which network the client has — see client/transport.js, which
       * explains at length why this is an alias and not a ternary over two
       * dynamic imports.
       */
      ...(LOCAL
        ? [{ find: /^(.*)\/transport\.js$/, replacement: '$1/transport.web.js' }]
        : []),
    ],
  },
  /**
   * The shop worker is a module worker (`new Worker(url, {type: 'module'})`), so
   * its bundle has to be one too. Vite's default here is `iife`, which cannot
   * code-split — and the shop worker splits, because `server/director.js`
   * imports the Anthropic SDK dynamically precisely so that a browser build
   * never fetches it. The error when this is wrong names the format and not the
   * import, so it reads as a Vite setting rather than as a consequence.
   */
  worker: { format: 'es' },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
  /**
   * `vite preview` serving the web build, and the one setting it needs that is
   * not obvious: Vite refuses a request whose `Host` header it does not know,
   * which is right (it is DNS-rebinding protection) and is exactly what a tunnel
   * looks like. Without this a quick tunnel answers **403** on every request,
   * with nothing in the Vite log to say why — it reads as the tunnel being
   * broken rather than as the server declining the hostname.
   *
   * Named rather than `true`: `true` turns the protection off for every host,
   * and the only ones wanted here are the quick tunnels used to hand a build to
   * somebody for ten minutes.
   */
  preview: {
    allowedHosts: ['.trycloudflare.com'],
  },
  server: {
    port: 5173,
    host: true,
    allowedHosts: ['.trycloudflare.com'],
    // The game server serves the control API; the websocket connects straight
    // to :2567 (see client/net.js), so only /api needs proxying here.
    proxy: {
      '/api': { target: 'http://localhost:2567', changeOrigin: true },
    },
  },
});
