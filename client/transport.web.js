/**
 * The web build's answer to [transport.js](transport.js) — see the note there.
 * Reached only through the alias in `vite.config.js`; nothing imports this file
 * by name.
 */

export { LocalNet as Transport } from './localnet.js';
