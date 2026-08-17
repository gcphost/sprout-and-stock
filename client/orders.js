/**
 * What is on a van, as the two questions anyone asks of it.
 *
 * Its own module because "6 eggs are arriving at 14:00" is a fact about the
 * world rather than a fact about the supplier panel, and it has two readers now:
 * the supplier's item list, and a shelf's own menu, which is where you are
 * standing when the question occurs to you. A second spelling of the fold would
 * be the usual bug — the shelf saying 6 coming while the supplier says 12,
 * because one of them counted the van and the other didn't.
 */

/**
 * What is on the van, per item, folded down to the legs it arrives in.
 *
 * One pass over `orders.pending` rather than a scan per row: the supplier is
 * forty items long and every one of them would otherwise walk the whole list
 * asking whether any of it was about *it*.
 *
 * A leg is a run, not an order. Two orders of eggs placed either side of a
 * coffee break both land at 14:00, and telling you that twice is a list you
 * have to add up yourself — what a shopkeeper wants is "eight eggs at 14:00",
 * which is exactly one leg. The split only survives where it means something,
 * which is a genuine second arrival time.
 *
 * `in` — seconds still to wait — is read for ordering the legs and never
 * printed. The player was told an hour ("on the 14:00 van"); a countdown is a
 * different promise, and a smaller one.
 */
export function comingByItem(ui) {
  const by = new Map();
  for (const o of ui.state?.orders?.pending ?? []) {
    let e = by.get(o.item_id);
    if (!e) { e = { qty: 0, legs: [] }; by.set(o.item_id, e); }
    e.qty += o.qty ?? 0;
    // On the van and merely booked are different sentences even at the same
    // hour, so they never fold into one another.
    const leg = e.legs.find((l) => l.at === o.at && l.onVan === (o.onVan === true));
    if (leg) leg.qty += o.qty ?? 0;
    else e.legs.push({ at: o.at, qty: o.qty ?? 0, onVan: o.onVan === true, in: o.in ?? 0 });
  }
  for (const e of by.values()) e.legs.sort((a, b) => a.in - b.in);
  return by;
}

/**
 * One item's inbound, as a sentence.
 *
 * The count says *how many* are coming; this says *when*, which is the half you
 * plan against. It is deliberately a sentence rather than a countdown —
 * "arriving at 14:00" is the thing you were told when you pressed the button,
 * and it stays true across a reload where a number of seconds would not.
 */
export function comingWhy(e) {
  const [first, ...rest] = e.legs;
  if (!first) return '';
  if (!rest.length) {
    return first.onVan ? `${e.qty} on the van now` : `${e.qty} arriving at ${first.at}`;
  }
  const leg = (l) => (l.onVan ? `${l.qty} on the van` : `${l.qty} at ${l.at}`);
  return `${e.qty} arriving — ${e.legs.map(leg).join(', ')}`;
}
