/**
 * The time of day as a shopkeeper would say it — 8 is "8am", 16:07 is "4:07pm".
 *
 * It lives in `shared/` for the reason `pieces.js` does: the two things that
 * print an hour are the HUD clock and every delivery-run label the sim writes,
 * and they are on opposite sides of the wire. A client reading "4:07pm" beside
 * a log line about "the 16:00 van" is two clocks in one shop.
 *
 * There are two spellings because there are two questions. A run is a whole
 * hour and nobody says "the 2:00pm van", so `hourLabel` drops the minutes;
 * `clockLabel` keeps them, and takes a fractional hour so its one caller does
 * not have to split it. If a delivery run ever lands at half past, that is the
 * moment `hourLabel` goes away rather than grows a branch.
 */

/**
 * 0 and 12 are the two a modulo gets wrong — both are "12" on a dial, and
 * `h % 12` answers 0 for each.
 */
const dial = (h) => (h % 12) || 12;
const half = (h) => (h < 12 ? 'am' : 'pm');
/** Whole hours only, wrapped — `nextRun` works in 0..47 before it wraps. */
const whole = (h) => ((Math.floor(h) % 24) + 24) % 24;

/** A whole hour: 8 → "8am", 14 → "2pm", 0 → "12am", 12 → "12pm". */
export const hourLabel = (h) => `${dial(whole(h))}${half(whole(h))}`;

/**
 * A fractional hour, minutes and all: 16.12 → "4:07pm".
 *
 * Minutes floor rather than round, because a clock that reads 5:00pm for the
 * last half minute of the afternoon has shut the shop early on paper.
 */
export const clockLabel = (h) => {
  const w = whole(h);
  const m = Math.floor((h - Math.floor(h)) * 60);
  return `${dial(w)}:${String(m).padStart(2, '0')}${half(w)}`;
};
