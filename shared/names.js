/**
 * WHAT SOMEBODY MAY CALL THEMSELVES, AND WHAT THEY MAY CALL THEIR SHOP.
 *
 * Two numbers and one function, shared for the reason `shared/start.js` is: the
 * box that takes the name and the code that keeps it have to agree, and a
 * `maxlength` on an input is not a limit — it is a hint to whoever is using the
 * input. Nothing about the game's own front door is the threat model here. Since
 * co-op, a name arrives from ANOTHER BROWSER over a data channel (`options.name`
 * on the join, `shop.js`), which is a string somebody else typed into something
 * that may not have been our form at all.
 *
 * What an unbounded one costs is not a crash. It is a nameplate that runs off
 * the screen, a log line that pushes every other line out of the feed, and a
 * `who` record on the save carrying whatever came in — all of it in a shop the
 * host cannot edit, because there is no way in the game to rename somebody
 * else. So the clamp belongs where the person is made (`Game.addPlayer`), which
 * is the one door every human comes through: the host who typed it, the guest
 * who sent it, and the balance bot that was handed one.
 *
 * The limits are what the PICTURE holds rather than what a column holds. A name
 * floats over a head about a tile wide and a shop's name sits in a card that
 * ellipsizes at roughly this many — past that the game is storing letters
 * nobody will ever be shown, which is the worst of both: not a limit, and not
 * legible either.
 */

/** A person. Sixteen fits over a head and in a log line without wrapping it. */
export const NAME_MAX = 16;

/**
 * A shop. Longer, because it is read on a card rather than at a distance — and
 * still short of the 32 the column was clamped at, which was three characters
 * more than `mintId` even looks at when it makes the id.
 */
export const SHOP_NAME_MAX = 24;

/**
 * A name as it will actually be kept: trimmed, one line, one space at a time.
 *
 * The length is the least of it. Everything in here is about a string that gets
 * printed into a feed and drawn over somebody's head:
 *
 * - **Control characters go**, because a newline in a name is a name that is
 *   two log lines, and the second one is not attributed to anybody.
 * - **The bidi overrides go with them.** They are the only characters that can
 *   reorder text *around* themselves — a name ending in U+202E prints the rest
 *   of the line backwards, which is a shop where "Ann clocked in" reads as
 *   something else entirely and nothing in the string looks wrong.
 * - **Runs of space collapse**, so twenty spaces cannot be a name that is a
 *   blank plate over a body.
 *
 * What is deliberately LEFT IN is the half worth checking before tightening
 * this: the zero-width joiners, U+200C and U+200D. They are what holds a family
 * emoji together and what makes Persian and several Indic scripts render
 * correctly, so stripping them is not a safety measure, it is spelling
 * somebody's name wrong. The zero-width *space* goes, because it is only ever a
 * blank pretending to be a letter.
 *
 * Sliced by CODE POINT rather than by index: a name cut in the middle of a
 * surrogate pair is a broken glyph, and the box's own `maxlength` counts UTF-16
 * units, so it is always the tighter of the two anyway. This is what runs on the
 * side that did not draw the box.
 */
export function cleanName(raw, max = NAME_MAX) {
  const flat = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...flat].slice(0, max).join('');
}
