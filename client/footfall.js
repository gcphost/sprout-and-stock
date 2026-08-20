/**
 * Whether the footfall overlay is up. That is all this file is.
 *
 * It kept the MAP too, once — a per-world grid in `localStorage`, accumulated
 * client-side. That went the day the sim started measuring footfall for itself:
 * the crew arrange the shop by the sim's map, so a browser keeping its own was
 * a second answer to one question, and two heatmaps of a shop both look right.
 * The map is on the save now and arrives over the wire.
 *
 * What is LEFT here is genuinely per-person rather than per-shop — whether you
 * like looking at it is a fact about you, the same call `sns.shutterUsed`
 * makes, so it survives across worlds and a second shop does not ask again.
 *
 * `localStorage` is a hostile environment — private mode, quota, a value left
 * by an older build — so every read is guarded and every write may fail
 * silently. The worst case is an overlay that starts hidden.
 */

const SHOW_KEY = 'sns.footfall.show';

/** Was the overlay up last time? Off unless somebody has said otherwise. */
export function footfallShown() {
  try { return localStorage.getItem(SHOW_KEY) === '1'; } catch { return false; }
}

export function setFootfallShown(on) {
  try {
    if (on) localStorage.setItem(SHOW_KEY, '1');
    else localStorage.removeItem(SHOW_KEY);
  } catch { /* the switch still works this session */ }
}
