/**
 * DOES THIS PERSON WANT LESS MOVEMENT?
 *
 * `prefers-reduced-motion` is a CSS media query, so it reached the HUD and
 * stopped at the edge of the canvas: nine blocks in `client/index.html` honour
 * it and `client/render/` had not one reference to it in the whole directory.
 * Which means the setting worked on the chrome and did nothing at all to the
 * thing filling the screen — and for a vestibular trigger, a strip of buttons
 * settling down while the shop behind it goes on swaying is the wrong half.
 *
 * WHAT THIS IS NOT FOR, and the line is worth drawing before anything else asks
 * for it. It is not a pause, and it is not a way to make the shop hold still:
 * people walking, the van driving and a blade turning on a machine that is
 * RUNNING are all information — docs/audio.md's argument about sound applies
 * exactly here, and `animateMotion`'s own note is blunter ("a machine that
 * cannot be seen working is a machine you cannot tell is on"). Taking those
 * away does not calm the shop down, it hides what the shop is doing, and it
 * would land as the game being broken for the people who asked for it.
 *
 * So the test for a caller is: **would somebody lose a fact?** Ambient motion
 * nobody reads is fair game. A thing that moves *because something happened* is
 * not.
 *
 * Read live rather than latched at boot. The query can change under a running
 * tab — a person turns it on in System Settings mid-session, precisely because
 * something is making them ill — and a value read once at startup is a setting
 * that only works if you restart the game. `matchMedia` is cached, `.matches`
 * is a property read, and the two callers ask once a frame at most.
 */

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Held rather than re-queried, because `matchMedia` itself parses the string
 * every call. The MediaQueryList is live — `.matches` tracks the setting on its
 * own — so holding it costs nothing and gives up nothing.
 */
const mq = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia(QUERY)
  : null;

/** True when this person has asked for less movement. */
export function calm() {
  return !!mq?.matches;
}
