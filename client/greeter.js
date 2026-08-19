/**
 * THE BOT WHO IS ON THE DOOR — one of your crew, turning, drawn without a
 * renderer and without a socket.
 *
 * This was the front door's alone until the loading screen wanted the same
 * thing, and two screens drawing a robot is exactly the "second way of drawing
 * a robot that has to be kept matching the first" the menu's own comment was
 * already arguing against. So the picture, the pick and the fetch live here and
 * both callers ask.
 *
 * Everything in here is deliberately transport-agnostic: `loadCrew` takes the
 * caller's own `api` rather than importing one, because the two callers are the
 * menu (which owns the swap between HTTP and the web build's Worker) and the
 * boot screen (which borrows it) — and importing the menu from here would close
 * a cycle for the sake of one function reference.
 */

import { spinForWorker } from './thumb.js';

/**
 * The worker kinds, fetched once for the life of the page.
 *
 * Off the content API rather than the catalog, because neither screen that
 * wants it has a socket: the front door runs before there is a shop to be told
 * about one, and the loader runs before the front door. Kept module-level so
 * the loading screen's fetch and the menu's are one fetch — they run seconds
 * apart on the same page and the second would be asking a question already
 * answered.
 */
let crew = null;
/** The in-flight fetch, so two callers a tick apart are still one request. */
let pending = null;

/**
 * ...AND IT IS REMEMBERED BETWEEN VISITS, which is the whole of why the loading
 * screen has a bot on it at all.
 *
 * The first version fetched, and the bot never once appeared. The reason is not
 * a slow request, it is the shape: the loading screen is up for exactly as long
 * as the thing it is waiting for, and on the web build BOTH the crew and the
 * shop come through the same Worker — so the crew can never arrive earlier than
 * the shop it is covering for, by construction. Measured on the front-door path
 * the two landed 1ms apart, and the turntable was built, inserted, and hidden in
 * the same tick. A loading screen whose picture is downstream of the load is not
 * a loading screen.
 *
 * So the art comes off localStorage, synchronously, before anything has awaited
 * anything — and the fetch's job is no longer to draw this visit's bot but to
 * leave a good one for the next one. A first-ever visit gets no bot, which is
 * the same answer the front door already gives a build with no worker art
 * authored: no placeholder, because a grey silhouette is worse than nothing.
 *
 * Trimmed to the three fields the picture is made of rather than stored whole.
 * Not for the 1.6KB — for what it says: this is a remembered *drawing*, not a
 * content cache, and nothing may ever read a wage or a job weight out of it.
 */
const REMEMBERED = 'sns-crew';
const DRAWN_WITH = ['id', 'model', 'tiers'];

/** Whatever was on the door last time, without waiting for anything. */
export function rememberedCrew() {
  try {
    const raw = localStorage.getItem(REMEMBERED);
    const rows = raw ? JSON.parse(raw) : null;
    return Array.isArray(rows) ? rows : null;
  } catch {
    // A quota error, private mode, or a row written by an older shape. All
    // three mean the same thing here — there is no bot — and none of them is
    // worth failing a page load over.
    return null;
  }
}

function remember(rows) {
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify(rows.map((w) => Object.fromEntries(
      DRAWN_WITH.filter((k) => w[k] !== undefined).map((k) => [k, w[k]]),
    ))));
  } catch { /* full, or private mode. The bot is not worth an exception. */ }
}

/**
 * The crew, for whoever is drawing one.
 *
 * Answers from what was remembered the moment there is anything remembered, and
 * refreshes the store behind that answer. The refresh deliberately does NOT
 * replace what this page is already using: `greeterOfTheDay` is a pure function
 * of the list, so swapping the list mid-session would change the bot on the
 * front door while somebody is looking at it — for no gain, since the only
 * thing that can have changed is art nobody has drawn yet.
 */
export async function loadCrew(api) {
  const fetched = () => {
    pending ??= api('GET', '/content/worker')
      .then((got) => got?.rows ?? [])
      .catch(() => []);
    return pending;
  };
  if (crew) return crew;
  const remembered = rememberedCrew();
  if (remembered?.length) {
    crew = remembered;
    fetched().then((rows) => { if (rows.length) remember(rows); });
    return crew;
  }
  crew = await fetched();
  if (crew.length) remember(crew);
  return crew;
}

/**
 * Which one is on the door.
 *
 * `hash01`'s argument said about a day rather than a person: picked off the
 * date, so the door has somebody different on it when you come back tomorrow
 * and the same one all evening — which also means the loading screen and the
 * front door behind it are showing the same machine, without either of them
 * having to tell the other.
 *
 * A shop with no worker art authored gets nothing at all — no placeholder,
 * because a grey silhouette over a title is worse than a title.
 */
export function greeterOfTheDay(from = crew) {
  const rows = (from ?? []).filter((w) => w.model);
  if (!rows.length) return null;
  return rows[Math.floor(Date.now() / 864e5) % rows.length];
}

/** How long one turn takes. Both screens, so they cannot drift out of step. */
const SPIN_SECONDS = 9;

/**
 * The turntable itself: the same filmstrip the worker sheet uses — twenty-four
 * stills fifteen degrees apart, laid in a row and slid one frame at a time by
 * `steps()` in `.wk-turn`. Nothing ticks and nothing is measured.
 *
 * `cls` is the clipping window it slides past, which is where the size lives:
 * `.menu-bot` is 132px over the title and `.boot-bot` is bigger, because on the
 * loader it is the only thing on the screen. Without a clipping parent you get
 * twenty-four robots in a row.
 *
 * The phase comes out as a NEGATIVE `animation-delay` — "start this far in" —
 * so the turn survives the rebuild the menu does on every keystroke that
 * matters. Without it the bot snaps back to facing front each time you type in
 * the name box.
 */
export function turntable(kind, cls = 'menu-bot') {
  const frames = kind && spinForWorker(kind, 1, null);
  if (!frames?.length) return '';
  const phase = (-(performance.now() / 1000) % SPIN_SECONDS).toFixed(2);
  return `<div class="${cls}" aria-hidden="true">
    <span class="wk-turn" style="--n:${frames.length};--spin:${SPIN_SECONDS}s;animation-delay:${phase}s">${
  frames.map((f) => `<span>${f}</span>`).join('')}</span>
  </div>`;
}
