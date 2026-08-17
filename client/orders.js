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
 * The next van, and how far along its journey it is.
 *
 * The other half of `comingByItem`: that one asks "what is coming for *this*
 * item", this one asks "what is coming *next*", which is the question you have
 * without a shelf in front of you — and the one the rail can answer with the
 * supplier shut.
 *
 * `p` is 0..1 of the journey covered, and it needs BOTH numbers the server
 * sends. `in` alone cannot say it: the runs are two hours apart in the day and
 * one hour apart overnight, so "twenty minutes to go" is most of the way there
 * on one and a third of the way on the other. `wait` is the distance, `in` is
 * what is left, and the ring is the difference.
 *
 * A leg is a run rather than an order, exactly as above — six orders on the
 * 14:00 van are one van, and a ring per order would be six rings all landing
 * at once.
 */
export function nextVan(ui) {
  const pending = ui.state?.orders?.pending ?? [];
  if (!pending.length) return null;

  const next = pending.reduce((a, b) => ((b.in ?? 0) < (a.in ?? 0) ? b : a));
  const onVan = next.onVan === true;
  // Everything landing with it, so the number says what the van holds rather
  // than what one row of it holds.
  const qty = pending
    .filter((o) => (o.onVan === true) === onVan && o.at === next.at)
    .reduce((n, o) => n + (o.qty ?? 0), 0);
  // ...and everything you have paid for that is not here yet, which is the
  // bigger number and the one that answers "have I already ordered that". The
  // ring is about the next van; this is about the whole road, and they are only
  // the same figure while there is one van out.
  const total = pending.reduce((n, o) => n + (o.qty ?? 0), 0);

  // Never shorter than what is left. A journey that claims to be over while
  // seconds remain would draw a full ring and then sit there, which is the
  // `onVan` case wearing the wrong colour — and it is what an order saved
  // before `wait` existed would otherwise do.
  const wait = Math.max(next.wait ?? 0, next.in ?? 0);
  const p = onVan || wait <= 0 ? 1 : Math.min(1, Math.max(0, 1 - (next.in ?? 0) / wait));

  // What the button says on hover. The HOUR, not a countdown in seconds: "on
  // the 14:00 van" is the promise the player was actually made, and it is still
  // true after a reload where a number of seconds would not be. The second
  // clause only appears when there IS a second van, or every order in the shop
  // reads as though it had been split in two.
  const leg = onVan ? 'on the van now' : `on the ${next.at} van`;
  const note = total === qty
    ? `${total} on the way, ${leg}`
    : `${total} on the way — ${qty} ${leg}`;

  return { at: next.at, onVan, qty, total, p, note };
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
