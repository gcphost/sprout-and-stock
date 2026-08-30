/**
 * THE LOADING SCREEN — what you look at while there is no shop yet.
 *
 * It was one line of text on a flat blue rectangle, which is the honest
 * description of a page that has not loaded rather than of a game that is
 * starting. That mattered little while the shop was a websocket to a server on
 * the same machine; on the web build there is a Worker to spawn, a store to
 * open and a world to lay out first, and the gap is long enough to read.
 *
 * Three decisions are worth knowing before changing it.
 *
 * **It is the front door's own sky**, not a loading theme of its own. `#boot`
 * and `#menu` both wear `.outdoors` — one set of rules for the sky, the lawn,
 * the tile lattice and the sun — so what you watch is the *same place* filling
 * in rather than one screen being replaced by another. That is also why the
 * boot screen goes away while the menu is up (`hide`) instead of sitting under
 * it: two copies of the same gradients composite, and the sun would be twice as
 * bright for as long as both were on screen.
 *
 * **The bot is remembered, never fetched.** It shipped fetched, and it was
 * never once visible — the crew and the shop come down the same pipe, so the
 * picture arrived in the same tick as the thing it was covering for. It is read
 * out of localStorage at module load now, and the fetch the front door makes is
 * what leaves one there for next time. See greeter.js.
 *
 * **The bar is indeterminate on purpose.** Nothing on this path reports
 * progress — `net.connect` is one await — so a bar that filled would be a
 * number invented to look reassuring, and it would still be sitting at 80% when
 * the shop opened.
 */

import { rememberedCrew, greeterOfTheDay, turntable } from './greeter.js';

const root = document.getElementById('boot');
const line = root.querySelector('.boot-say');
const stage = root.querySelector('.boot-stage');

/**
 * The bot, drawn at module load out of what was remembered from last visit.
 *
 * SYNCHRONOUS AND NEVER A FETCH — see the long note on `REMEMBERED` in
 * greeter.js. The first version of this asked the server and drew the answer
 * when it came, and the bot was never once on screen: the loading screen is up
 * for exactly as long as the thing it is waiting for, so a picture fetched
 * alongside that thing arrives at the moment the screen stands down. Painted
 * here rather than in `bootSay` so it is in the first frame the browser puts
 * up, which on a cold load is a second or more before any module has finished
 * doing anything.
 *
 * Nothing to do on a first-ever visit, and that is the honest answer rather
 * than a gap in the feature: the front door gives the same one to a build with
 * no worker art authored. The bar and the line carry that load alone, and the
 * fetch the front door makes a moment later leaves a bot here for next time.
 */
const html = turntable(greeterOfTheDay(rememberedCrew()), 'menu-bot boot-bot');
if (html) stage.innerHTML = html;

/**
 * Say what is happening, and be visible while saying it.
 *
 * Every caller that sets the line also means "show me" — the only two states
 * this screen has are up with a line on it and gone — so the unhide is here
 * rather than a second call every caller has to remember.
 */
export function bootSay(text) {
  line.textContent = text;
  root.hidden = false;
}

/** Step aside for the front door, which draws the same sky. */
export function bootHide() {
  root.hidden = true;
}

/**
 * The shop is up — and by the time this runs it is genuinely up, which it was
 * not for the whole life of this screen.
 *
 * It used to be called the moment the socket joined, three messages before
 * there was anything to uncover, so what it revealed was an empty sky under a
 * HUD reading `Day 1 · $0.00` for about half a second before the real shop
 * arrived over the top of it. The wait is `stepReveal` in client/main.js; this
 * end only has to get out of the way nicely.
 *
 * Faded rather than cut, and then REMOVED rather than left at zero: it covers
 * the whole viewport, and an invisible sheet over the shop is a shop you cannot
 * click. The timer is the belt to that brace — `prefers-reduced-motion` takes
 * the transition away (see index.html), and a transition that never runs never
 * fires the event. Removing twice is a no-op, so both paths can simply fire.
 */
export function bootDone() {
  root.classList.add('done');
  root.addEventListener('transitionend', () => root.remove(), { once: true });
  setTimeout(() => root.remove(), 600);
}

/**
 * It did not work out.
 *
 * The bar goes, because a thing that is still travelling under a sentence
 * saying it failed reads as the game not having noticed. The bot stays: this is
 * the one screen somebody may be stuck on, and a machine standing next to the
 * bad news is better company than the bad news alone.
 */
export function bootFail(text) {
  bootSay(text);
  root.classList.add('failed');
}
