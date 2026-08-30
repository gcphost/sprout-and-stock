/**
 * HOW BIG THE CHROME IS — one number, and the two spaces it creates.
 *
 * Every length in the stylesheet is a literal px, which is right: a 10.5px
 * caption and a 40px nav button were each chosen against the things next to
 * them, and a `rem` scale would have made all four hundred of them a fraction
 * of one font size nobody ever wanted to think in. What it costs is that there
 * is no dial — "a bit smaller" is four hundred edits, none of which is the
 * decision being made.
 *
 * `zoom` is the dial. It multiplies every used length inside `.hud`, so the
 * whole HUD steps down together and no proportion in the stylesheet moves. It
 * is on `.hud` rather than on the root because the CANVAS must not be touched:
 * the shop is drawn at device pixels and picked at pointer coordinates, and a
 * zoomed root is a renderer aiming at a viewport that is no longer the one the
 * mouse is in.
 *
 * ---- THE TWO SPACES ----------------------------------------------------
 *
 * That leaves the one thing anybody has to remember here, and it is a real
 * trap because both sides read as "pixels":
 *
 *   - `getBoundingClientRect`, `e.clientX/Y`, `innerWidth/innerHeight` are in
 *     VIEWPORT px — what the screen shows, unzoomed.
 *   - `offsetWidth/offsetHeight/offsetLeft` and any inline `left: Npx` you
 *     write onto a zoomed element are in HUD px — the space the stylesheet is
 *     written in.
 *
 * They were the same number for as long as the zoom was 1, which is every line
 * of this client up to today. Mix them at 0.85 and nothing errors: a tooltip
 * lands 15% of the way toward the top-left corner of the screen, a dragged
 * panel trails the pointer, a shapes card sits left of the tile it belongs to.
 * Each is a few pixels at the middle of the screen and a long way out at the
 * edges, which reads as drift rather than as arithmetic.
 *
 * So: anything measured off a rect, a pointer or the window, and then written
 * INTO the HUD, goes through `hudPx`. Anything already measured with `offset*`
 * is in the right space and must NOT. There are five callers, and each says so
 * where it converts.
 *
 * `#marquee` is the one thing wearing `.hud` that opts out (`zoom: 1` in the
 * stylesheet): it is a rectangle drawn over the SHOP at the pointer's own
 * coordinates rather than a piece of chrome, so it belongs in viewport space
 * with the canvas it is dragged across.
 */

/** A fact about the person and their screen, not about the shop. */
const KEY = 'sns-ui-scale';

/* The ends and the step. Below 0.7 the 8px legends in the build bar stop being
   words; above about 1.15 the panel is wider than the shop behind it on the
   window this was reported from. The step is coarse on purpose — this is a
   thing you set once, and a 1% nudge is a press that answers the number it
   already had.

   ...AND 1.15 WAS THE WRONG KIND OF CEILING, which is worth separating out
   because the reason above is still true. "The panel is wider than the shop
   behind it" is a LOOK, measured on one window — and the top of this range is
   not a taste control, it is the only magnification this game has. The HUD is
   full of 8, 9 and 10px type; at the 0.85 default an 8px legend renders at
   6.8 real pixels, and 1.15 buys somebody who cannot read that a third of a
   step. Capping a legibility control on how tidy the result looks is deciding
   for the person who needs it, on a window that is not theirs.

   So the top is 1.5 and the cost is theirs to weigh: the panel does get wide,
   the shop does get crowded, and both are visible the instant they press it
   and reversible by pressing the other way. The bottom is untouched — 0.7 is
   a legibility floor, and that IS a real one, because past it the words stop
   being words for everybody. */
export const UI_MIN = 0.7;
export const UI_MAX = 1.5;
export const UI_STEP = 0.05;
/* A notch down from where the stylesheet was drawn, which is the change this
   file was added for. It is the DEFAULT rather than the only setting, because
   how big a HUD wants to be is a fact about the window it is in — see the
   stepper in client/sections.js. */
export const UI_DEF = 0.85;

const clamp = (v) => Math.min(UI_MAX, Math.max(UI_MIN, Math.round(v * 20) / 20));

let scale = UI_DEF;

/** How big the chrome is, as the multiplier the stylesheet is wearing. */
export function uiScale() { return scale; }

/**
 * Viewport px → HUD px. The whole of the seam above, in one divide.
 *
 * Named for what it ANSWERS rather than for what it does, because the mistake
 * this exists to stop is calling it on a number that is already in HUD space.
 */
export function hudPx(n) { return n / scale; }

/** Put it on the root, where the stylesheet reads it. */
function paint() {
  document.documentElement.style.setProperty('--ui', String(scale));
}

/**
 * Set it, remember it, and show it.
 *
 * Nothing has to be re-measured afterwards, which is worth knowing before
 * somebody adds a callback here: `--build-h` and `--hud-h` are both written
 * from `offsetHeight`, so they are already in HUD px and mean the same thing at
 * every scale. The only numbers that move are the ones this file converts, and
 * every one of those is computed at the moment it is used.
 */
export function setUiScale(v) {
  scale = clamp(Number(v) || UI_DEF);
  paint();
  try { localStorage.setItem(KEY, String(scale)); } catch { /* private mode */ }
  return scale;
}

/**
 * What was stored, at boot.
 *
 * The stylesheet carries `UI_DEF` itself, so there is no flash and no frame
 * drawn at the wrong size before this runs — this only ever overrides a person
 * who has been to the stepper.
 */
export function applyUiScale() {
  let v = null;
  try { v = localStorage.getItem(KEY); } catch { /* private mode */ }
  scale = v == null ? UI_DEF : clamp(Number(v) || UI_DEF);
  paint();
  return scale;
}
