/**
 * Which grammar the shop is being played with.
 *
 * One question, asked by three things that have to agree about it: what a tap
 * DOES (`tapAtPointer` in main.js), what the pill OFFERS (`pressHints`), and
 * what the tour SAYS (client/tutor.js). Two of those could live together; the
 * third is why this is a file. ui.js imports sections.js, sections.js imports
 * tutor.js, so a test kept in ui.js and read by the tour closes a cycle — it
 * would work, because nothing calls it at module scope, and it would be a cycle
 * nobody meant that the next import turns into a real one.
 *
 * The test is the WIDTH and not `pointer: coarse`, and it is the same query the
 * pill's rows use for their `pointer-events` in index.html. Those are two halves
 * of one decision: a tap may only stop being a verb where the pill is pressable,
 * or the verbs have left the world and landed nowhere. And a phone in a desktop
 * browser's device emulation is where this actually gets tested — it does not
 * reliably report a coarse pointer.
 */
export const pillDrives = () => matchMedia('(max-width: 640px)').matches;

/**
 * A mouse with one of its two buttons pressed. See `updatePrompt`.
 *
 * Drawn here rather than taken from `icons.js`, which is generated from two
 * stock icon sets: a stock mouse is one shape with both buttons the same, and
 * the entire content of this picture is that ONE of them is filled. An icon
 * that cannot say which button it means is a picture of the problem.
 *
 * The pressed half is its own path with a class on it, so the pulse is a fill
 * that lights rather than a whole glyph that flashes — a shape blinking on and
 * off reads as something wrong, and a button going down and coming back up
 * reads as a click, which is the only thing it is trying to say.
 *
 * `currentColor` throughout: the pill inverts itself when it is armed
 * (`#prompt.going`), and a glyph with a colour of its own would go on being
 * white on gold.
 *
 * IT LIVES IN THIS FILE for the reason the file exists, one axis along: the
 * tour draws it too now — the card that teaches turning the view puts this
 * exact mouse on an arc and slides it along (see `dragArt` in tutor.js) — and
 * the whole point of that card is that the button on it is the button the pill
 * has been showing you all along. Kept in ui.js it would be the same cycle
 * `pillDrives` was moved here to avoid.
 *
 * `attrs` is how a caller that is not a pill places it: inside another SVG a
 * nested one needs `x`/`y`/`width`/`height` in the parent's user units, and
 * nothing in the pill's own layout has any business knowing those.
 */
export function mouseGlyph(right, attrs = '') {
  // The pressed cap, drawn as the corner it actually is: down the divider,
  // along the top under the shoulder, and back. Mirrored about x=7 for the
  // right one rather than authored twice, because two hand-drawn halves drift
  // and the divider stops lining up with itself.
  const cap = right
    ? 'M7.6 1.3h1.8a3.3 3.3 0 0 1 3.3 3.3v2.1H7.6z'
    : 'M6.4 1.3H4.6a3.3 3.3 0 0 0-3.3 3.3v2.1h5.1z';
  return `<svg class="pr-mouse"${attrs ? ` ${attrs}` : ''} viewBox="0 0 14 20" aria-hidden="true">`
    + '<rect x="1.3" y="1.3" width="11.4" height="17.4" rx="5.7"'
    + ' fill="none" stroke="currentColor" stroke-width="1.3" opacity=".55"/>'
    + '<path d="M1.3 7.4h11.4M7 1.3v6.1" stroke="currentColor"'
    + ' stroke-width="1.1" opacity=".55"/>'
    + `<path class="pr-press" d="${cap}" fill="currentColor"/></svg>`;
}
