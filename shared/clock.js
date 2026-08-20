/**
 * The time of day as a shopkeeper would say it — 8 is "8am", 16:07 is "4:07pm".
 * And, since the day roll, the other hand of the same clock: what the DATE is.
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

/**
 * ---- the calendar ------------------------------------------------------
 *
 * A season is exactly a week, which is a fact `onNewDay` has always asserted in
 * one expression and nothing else in the game has ever been able to read. So
 * the shop kept a running day count and a season word, and between them there
 * was no way to answer the question a shopkeeper actually asks — *how far
 * through the week am I* — even though the answer was already sitting in the
 * day number. `SEASON_DAYS` is that expression's 7 given a name and one home,
 * because the moment the HUD prints a weekday there are two readers of the same
 * number: a client that spells it 7 while the sim rolls the season on some
 * other figure is a calendar whose Monday is not the first day of spring, and
 * nothing anywhere would say a word about it.
 *
 * The weekday is therefore *derived* rather than stored, and there is no field
 * for it on the save. Day 1 is a Monday and every season starts on one, which
 * is not a coincidence to be tidied away later — it is what makes the weekday
 * and the day-of-season the same number, and it is why the report's week and
 * the world's season can never drift apart by construction.
 */

/** A season is a week. Four of them make a 28-day year. */
export const SEASON_DAYS = 7;

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

/** Day 1 is a Monday, so this index is the day-of-season and the weekday both. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Both of these wrap the modulo by hand rather than trusting `%`, which is
 * signed in JS. No shop has a day zero today; `simulate` and the sweeps build
 * their own worlds, and one that ever counted backwards would come back
 * `undefined` rather than wrong, which is a blank in the HUD nobody can read.
 */
const wrap = (n, of) => ((n % of) + of) % of;

/** Which season day N falls in — the sim's own roll, and the only spelling. */
export const seasonFor = (day) => (
  SEASONS[wrap(Math.floor((Math.floor(day) - 1) / SEASON_DAYS), SEASONS.length)]
);

/** What today is called: day 1 → "Mon", day 62 → "Sat". */
export const weekdayLabel = (day) => WEEKDAYS[wrap(Math.floor(day) - 1, SEASON_DAYS)];
