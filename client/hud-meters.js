/**
 * The two passive readouts in the top-left corner, as pure functions.
 *
 * Both take a slice of the snapshot and hand back a string of HTML. Nothing in
 * here touches the DOM, holds state or knows about `UI` — the caller diffs a
 * signature and writes the result, the way every other 10Hz readout in this
 * client does. They live outside `ui.js` because that file is already twice its
 * 600-line cap and drawing is the most self-contained thing in it (see the
 * "still to do" list in docs/ui-shell.md).
 */

import { DEPARTMENTS } from '../shared/tags.js';
import { money } from './money.js';

/** The plot is 56px wide with the axis down the middle, so a full bar is 28. */
const HALF = 26;
/**
 * How far from level a department has to be before it draws anything.
 *
 * A department with nothing to say draws no bar at all rather than a 1px stub,
 * and that is not a rounding detail. Twelve rows are always on screen and most
 * of them are level most of the time, so a stub on every row is a meter that
 * always looks like it is reporting something — the eye has to measure twelve
 * lengths to find out that eleven of them mean nothing. Bare axis means nothing
 * to do here, which is the reading you want to be able to take without looking.
 */
const DEADBAND = 0.04;

const title = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * THE DEMAND METER — twelve departments, one shared axis, never any other shape.
 *
 * The order and the row set come from `DEPARTMENTS` here rather than from the
 * wire, even though the server sends them in that order. The whole complaint
 * against what this replaced was that its rows moved, so the client owning the
 * shape means a snapshot can only ever change the *lengths* — there is no
 * message the server can send that reorders the meter or drops a row out of it.
 * A department the server has said nothing about draws level.
 *
 * Right is "the town asked and you were short", left is "this space isn't
 * earning". See `departmentMeter` in server/sim/economy.js for how each is
 * measured; the two halves are two different tallies and it matters.
 */
export function rciHtml(departments = []) {
  const by = new Map(departments.map((d) => [d.dept, d]));

  return DEPARTMENTS.map((dept) => {
    const d = by.get(dept) ?? { net: 0, fill: null, boards: 0, event: 1 };
    const net = d.net ?? 0;
    const w = Math.abs(net) * HALF;
    const bar = Math.abs(net) < DEADBAND
      ? ''
      : `<span class="mtr-bar" style="width:${w.toFixed(1)}px"></span>`;
    // An event pulling this department is worth a mark, because it is the one
    // thing on the row that is about to change and not about what you did. It
    // rides the label rather than the bar: the bar already has the event folded
    // into its length, so a second mark on it would be the same fact twice.
    const evt = d.event >= 1.25 ? ' hot' : d.event <= 0.8 ? ' cold' : '';
    return `<span class="mtr ${net >= 0 ? 'up' : 'down'}" title="${rciWhy(dept, d)}">`
      + `<span class="mtr-tag${evt}">${dept}</span>`
      + `<span class="mtr-plot">${bar}</span>`
      + `</span>`;
  }).join('');
}

/**
 * The row in words, on the hover.
 *
 * A bar says how much and which way; it cannot say which of the two tallies
 * moved it, and those call for opposite actions. Same trick the 214px panel uses
 * to stay one line per row — the short version is on screen, the whole of it is
 * on `title`.
 */
function rciWhy(dept, d) {
  const fill = d.fill === null || d.fill === undefined
    ? 'nobody has asked for it'
    : `${Math.round(d.fill * 100)}% of asks filled`;
  const shelf = d.boards
    ? `${d.boards} board${d.boards === 1 ? '' : 's'} of it out`
    : 'none on the shelves';
  const verdict = (d.net ?? 0) >= DEADBAND
    ? 'get more in'
    : (d.net ?? 0) <= -DEADBAND
      ? 'more shelf than it earns'
      : 'about right';
  const event = d.event >= 1.25
    ? ` · wanted ×${d.event}`
    : d.event <= 0.8 ? ` · out of favour ×${d.event}` : '';
  return `${title(dept)} — ${verdict}. ${fill}, ${shelf}${event}`;
}

/**
 * THE CASHFLOW READOUT — today's net, and whether that beats yesterday.
 *
 * Cash on hand was the only number in the corner, and a balance is not a rate:
 * you can watch it climb all week while every day loses money against the wages.
 *
 * The arrow is only drawn when there *is* a yesterday. A shop on day one has no
 * comparison and saying "▲" against an assumed zero would make the first day of
 * every shop a triumph.
 *
 * The WEEK's shape was drawn here too, as a sparkline off `days`. It is gone
 * from the corner — a week of finished days is a consultation rather than a
 * reading, and the Shop report draws the same seven days four times the height
 * with labels on them. `ledger` stays in the signature because yesterday comes
 * out of it.
 */
export function cashflowHtml(stats = {}, ledger = []) {
  const today = (stats.revenue ?? 0) - (stats.spent ?? 0);
  const days = ledger.map((d) => (d.revenue ?? 0) - (d.spent ?? 0));
  const yesterday = days.length ? days[days.length - 1] : null;

  const dir = yesterday === null ? '' : today > yesterday ? 'up' : today < yesterday ? 'down' : 'flat';
  const arrow = { up: '▲', down: '▼', flat: '·' }[dir] ?? '';
  const hint = yesterday === null
    ? 'today so far — no finished day to compare with yet'
    : `today so far, against ${money(yesterday)} yesterday`;

  return `<span class="flow ${today < 0 ? 'down' : 'up'}" title="${hint}">`
    + `<b>${money(today)}</b>${arrow ? `<i class="${dir}">${arrow}</i>` : ''}`
    + `</span>`;
}

/**
 * Where zero sits, and how far it is to either end.
 *
 * THE ZERO LINE FLOATS, and that is the whole of what this exists to say once.
 * With no losing day in the week the bars grow off the bottom and use the full
 * height; a losing day pushes zero up to make room below it. A fixed mid-height
 * axis would spend half the widget on a half nothing normally reaches.
 *
 * Exported because the Shop panel draws this picture twice at two heights — the
 * week's profit and the week's reputation — and the corner sparkline drew it a
 * third time at 12px until it left the card. What they must not disagree about
 * is where zero is: two widgets showing the same seven days with the axis in
 * different places is one of them being wrong, and neither is provable by eye
 * because they are never on screen together. It stays here rather than moving
 * into `report.js` with its two remaining callers for the same reason it was
 * shared in the first place — the next readout that draws a week finds it.
 *
 * `top`/`bottom` are clamped through zero, so a week entirely in profit still
 * measures from 0 rather than from its own worst day — otherwise the shape is
 * of the *variation* and a flat good week looks like a crisis.
 */
export function zeroScale(values, height) {
  const top = Math.max(...values, 0);
  const bottom = Math.min(...values, 0);
  const span = top - bottom || 1;
  return { top, bottom, span, zero: (top / span) * height };
}
