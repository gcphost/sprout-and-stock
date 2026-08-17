/**
 * ONE spelling of an amount of money.
 *
 * Every readout in this client carried its own `` `$${n.toFixed(2)}` ``, which
 * is right at $4.20 and falls apart at $108389.91: an ungrouped nine-digit run
 * is a number you read a digit at a time, and the two cents on the end of it
 * are noise you have to look past to find the thousands. So amounts are
 * grouped, and cents are printed only where they are a real share of the
 * figure.
 *
 * That last bit is a threshold rather than a preference, because both ends of
 * it are already written down in here. `client/hud-meters.js` drew the line at
 * $10 and this is that rule promoted, so a figure shown in two places stops
 * being spelled two ways. And `client/worker-menu.js` says why the small end
 * may not be rounded: a $3.50 wage printed as "$4" over-states what a hire
 * costs by a seventh, which is the same lie as a button promising a different
 * price to the one it charges. Seeds, unit prices and wages sit under the line;
 * cash, build costs and a day's takings sit over it.
 *
 * Pass `dp` where a caller knows better than the threshold.
 */

/** Under this, cents are a real share of the figure. Over it, they are noise. */
const CENTS_UNDER = 10;

const digits = (n) => (Math.abs(n) < CENTS_UNDER ? 2 : 0);

/**
 * `$108,389` · `$3.50` · `−$12`.
 *
 * The sign leads the `$` rather than sitting inside it, so the symbol is in the
 * same place on every line of a column and a minus never shifts the figure.
 *
 * Cents that are not printed are DROPPED rather than rounded, and that is the
 * one decision in here worth keeping. The number this is mostly asked about is
 * a balance, and a balance that rounds up claims a dollar the shop has not got
 * — which reads as broken exactly where it matters most, on the greyed-out
 * button that says "$340 and you have $340". Nothing is lost at the other end:
 * a price is authored, and an authored price is a whole number.
 */
export function money(n, dp) {
  const v = Number(n) || 0;
  const places = dp ?? digits(v);
  const size = Math.abs(v);
  return `${v < 0 ? '−' : ''}$${(places ? size : Math.floor(size)).toLocaleString('en-US', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })}`;
}

/** A delta, where the sign is most of what is being read. */
export const signed = (n, dp) => `${Number(n) < 0 ? '' : '+'}${money(n, dp)}`;
