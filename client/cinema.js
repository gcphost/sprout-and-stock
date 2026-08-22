/**
 * THE HUD TAKEN OFF THE SCREEN, FOR SOMEBODY WITH A CAPTURE RUNNING.
 *
 * There is nothing to record here that the game does not already draw. What
 * there is, is eleven pieces of chrome in front of it — the rail, the meters,
 * the log, the carry pill, the corner widgets, the two build buttons — every one
 * of which is doing its job and all of which say "screenshot of a UI" rather
 * than "shop". A demo is a picture of the world, and the world is the one part
 * of the screen that needs no explaining.
 *
 * So this is one class on `<body>` and the rest is CSS (client/index.html):
 * `.hud` goes, and two bars come in. There is deliberately no JavaScript that
 * knows what a rail is — every piece of chrome in the game already carries the
 * class that hides it, so a widget added tomorrow is covered on the day it
 * exists, and one that is *not* covered is one that was never HUD in the first
 * place. That is the same argument `switchGrid` makes about `CORNERS`.
 *
 * IT IS NOT REMEMBERED, and that is the only decision in here worth arguing.
 * Every other switch in the game is persisted because it is a fact about the
 * person — how loud they like it, whether they want the tour. This one is a
 * fact about the next ninety seconds. Persisted, the failure is a game that
 * boots with no HUD at all, days later, for somebody who has long forgotten
 * there is a key that brings it back — and a shop with no rail, no meters and
 * no way in to the menu is not a setting that is on, it is a game that looks
 * broken. The letterbox says the key, which is the other half of the same
 * argument: the one thing left on screen has to be able to explain itself,
 * because the panel the switch lives on is the first thing this hides.
 */

/** Whether the chrome is off. */
let on = false;

/**
 * Who else has to know.
 *
 * The renderer does — a capture wants a camera that glides rather than one that
 * keeps up — and it is the only thing outside the DOM that cares. A list rather
 * than an import, because this module knowing about the scene would make the
 * scene's own boot order this file's problem, and because the two callers of
 * `setCinema` (the key and the switch tile) must not each have to remember to
 * tell it. One wire, made once, at boot.
 */
const watchers = new Set();

/** Register, and get told the state as it stands so nobody starts out of step. */
export function onCinema(fn) {
  watchers.add(fn);
  fn(on);
  return () => watchers.delete(fn);
}

export const cinemaOn = () => on;

/**
 * Turn it on or off, and answer where it landed.
 *
 * Answering rather than returning nothing so a caller can toast the state it
 * actually reached instead of the one it asked for — the same reason
 * `setFirstPerson` does.
 */
export function setCinema(next) {
  on = !!next;
  document.body.classList.toggle('cinema', on);
  for (const fn of watchers) fn(on);
  return on;
}
