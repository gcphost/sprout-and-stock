import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: 'client',
  publicDir: false,
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: true,
    // The game server serves the control API; the websocket connects straight
    // to :2567 (see client/net.js), so only /api needs proxying here.
    proxy: {
      '/api': { target: 'http://localhost:2567', changeOrigin: true },
    },
  },
});
