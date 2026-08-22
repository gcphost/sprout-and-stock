/**
 * THE TWO READOUTS THAT WERE ONLY REACHABLE BY TYPING IN THE ADDRESS BAR.
 *
 * The frame clock (`stepPerf`) and the tile grid (`client/render/tile-grid.js`)
 * were each a `URLSearchParams(...).has(...)` read at module load, which is the
 * cheapest possible switch and is a switch with two things wrong with it. It is
 * **undiscoverable** — nothing in the game says either of these exists, so the
 * only people who ever saw them are the people who wrote them — and it is
 * **one-way**: the way to turn a readout off is to edit the URL and reload,
 * which throws away the shop you were looking at, which is the exact thing you
 * had the readout up to look at. "It feels chunky here" is a report you get by
 * standing somewhere; a reload puts you back at the door.
 *
 * So they are switches like every other switch, on the Menu's own grid beside
 * the tour and the sound. Three things about this file:
 *
 * The **URL still works**, and is read once at load. Every note written about
 * `?perf` and `?tiles` — in this repo and in a chat log somebody keeps — stays
 * true, and handing a link to somebody whose game is chunky is still the one
 * gesture that gets a readout on their screen without talking them through a
 * menu. What the URL cannot be is the *only* way in.
 *
 * It is **persisted**, which is the opposite call to `client/cinema.js` and for
 * the reason that file gives: cinema hides the way back, so remembering it is a
 * game that boots looking broken. These add a small box in a corner and leave
 * every control on screen, and the switch that turns one off is two presses
 * away in the menu it was turned on from. A tester who wants the frame clock
 * wants it tomorrow as well.
 *
 * And the list is **exported**, so the Menu draws its tiles off it rather than
 * writing them out — the same argument `CORNERS` makes in client/corner.js. A
 * third readout added here is on the switch grid the day it exists, and one
 * that is not on the list is one nobody can turn off.
 */

const STORE = 'sns-debug';

/**
 * Everything in here, in the order the Menu lists it.
 *
 * `icon` is a name in `client/icons.js` rather than the glyph, so this module
 * stays free of the renderer's imports — the Menu resolves it.
 */
export const DEBUGS = [
  {
    id: 'perf',
    icon: 'quick',
    name: 'Frame clock',
    sub: 'fps, the worst frame, draws and triangles — bottom left',
  },
  {
    id: 'tiles',
    icon: 'floor',
    name: 'Tile grid',
    sub: 'every tile wearing its coordinates, and the one under the pointer',
  },
];

/** localStorage is a hostile environment: private mode, quota, a stale value. */
function saved() {
  try { return JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { return {}; }
}
function store(map) {
  try { localStorage.setItem(STORE, JSON.stringify(map)); } catch { /* not worth a toast */ }
}

/**
 * The state, seeded once.
 *
 * The URL wins at boot and is deliberately NOT written to the store: a link
 * somebody was handed is a thing they were shown, not a preference they set,
 * and a `?perf` that quietly stuck would have the readout following them into
 * every shop they opened afterwards with nothing to connect it to a URL they
 * clicked once.
 */
const asked = new URLSearchParams(location.search);
const on = new Map(DEBUGS.map((d) => [d.id, asked.has(d.id) || saved()[d.id] === true]));

/**
 * Who else has to know — the frame loop, and the scene that draws the grid.
 *
 * A watcher list rather than an import, for `onCinema`'s reason: this module
 * knowing about the scene would make the scene's boot order this file's
 * problem. Registering replays the current state for every id, so a listener
 * can never start out of step with a URL that was read before it existed.
 */
const watchers = new Set();

export function onDebug(fn) {
  watchers.add(fn);
  for (const d of DEBUGS) fn(d.id, on.get(d.id) === true);
  return () => watchers.delete(fn);
}

export const debugOn = (id) => on.get(id) === true;

/** Nothing stored for one that is off — the default is the absence. */
export function setDebug(id, next) {
  on.set(id, !!next);
  const map = saved();
  if (next) map[id] = true;
  else delete map[id];
  store(map);
  for (const fn of watchers) fn(id, !!next);
  return !!next;
}
