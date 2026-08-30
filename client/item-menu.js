/**
 * One menu per item.
 *
 * Tapping a row in the supplier opens the thing itself, exactly the way tapping
 * a shelf opens that shelf — and for the same reason the worker menu exists: a
 * list row is a sentence you scan, and every control you hang off one is a
 * decision squeezed into the gap between a name and a button. The supplier's
 * row carried three of them (a toggle and two steppers, at fifteen pixels a
 * side), which is a mouse's control on a game half of which is played with a
 * finger.
 *
 * So the row goes back to being a row — name, heat, how many you hold, one
 * button — and everything you might *decide* about the item lives here, at the
 * width of the panel.
 *
 * What is new rather than moved is the price. A price has always been a fact
 * about a BOARD (`stack.price`, set from the suggestion when the board opens),
 * which means a shop with eggs on three shelves had to say what it charges for
 * eggs three times, and any board opened afterwards said the suggestion back at
 * you. The standing price is the same sentence the two numbers beside it
 * already make: `min` and `max` are about the shop rather than about a unit of
 * shelving, and so is "I charge $3.20 for these". See `Game.itemPrice`.
 *
 * Functions take `ui` first rather than living on it, like `worker-menu.js` and
 * `fixture-menu.js` — this reads the snapshot and sends messages, it is not
 * part of the HUD's state.
 */

import { ICONS } from './icons.js';
import { money } from './money.js';
import { actIcon } from './fixture-menu.js';
import { comingByItem, comingWhy } from './orders.js';
// The item drawn from its own catalog row — the same picture the supplier's
// rows wear and the same one the shelf builds its stock from.
import { artForModel } from './thumb.js';

/** Item names come out of the database, so never raw. */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/**
 * How much one press of `+` moves a price.
 *
 * A flat step cannot serve this catalogue: the same quarter that is a sensible
 * nudge on a $2.90 loaf is four presses to move a $16.50 bottle by a tenth of
 * what it costs. So it is a twentieth of the price, rounded to something a
 * shopkeeper would actually write on a label, and never finer than 5c — which
 * makes every press worth about 5% wherever you are on the ladder.
 *
 * Read off the price on the row rather than off `base_price`, so a shop that
 * has decided to charge triple steps in triple-sized nudges rather than
 * crawling back down in 5c hops.
 */
export function priceStep(now) {
  return Math.max(0.05, Math.round((now * 0.05) / 0.05) * 0.05);
}

/** Money, to the penny, the way every price in this game is stored. */
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * How many one press of `+` adds to an order — and what one order starts at.
 *
 * Six, because that is the number the supplier's row has said since there was a
 * row: `×6` there and `×6` here are one press, so stepping this by anything else
 * would make the two controls disagree about what a case of something is. The
 * ceiling is the shop's, not a number in here — the bay, the floor and the till
 * each refuse by name in `Game.buyStock`, which is why there is no fourth one
 * clipping the stepper silently.
 */
const ORDER_STEP = 6;

/**
 * What a board of this is charging right now, or null if none is.
 *
 * The shop in front of you rather than a second opinion about what it *ought*
 * to be charging: the suggestion is the server's arithmetic over tags, season
 * and world events (`suggestedPrice`), and a client-side copy of it would be
 * the usual bug — a menu quoting a fair price the sim has never heard of.
 * Every board opens at `Game.itemPrice`, so on an item you have not priced
 * yourself this IS the suggestion, read back off the shelf it landed on.
 */
function onTheShelf(ui, itemId) {
  for (const s of ui.state?.shelves ?? []) {
    for (const k of s.stacks ?? []) if (k.item_id === itemId && k.qty > 0) return k.price ?? null;
  }
  // A board standing empty still carries the price it opened at, and it is the
  // right answer when the shop has sold out — second pass rather than first, so
  // a full board always wins over a bare one.
  for (const s of ui.state?.shelves ?? []) {
    for (const k of s.stacks ?? []) if (k.item_id === itemId) return k.price ?? null;
  }
  return null;
}

/** Which appliance makes this, if one does — the same test the supplier makes. */
function madeIn(ui, itemId) {
  const rec = (ui.catalog.recipes ?? []).find((r) => r.output_id === itemId);
  if (!rec) return null;
  return (ui.catalog.fixtures ?? []).find((f) => f.id === rec.station)?.name ?? null;
}

/**
 * Open the menu for one item.
 *
 * Takes the id rather than the row, because everything on this screen is live —
 * what you hold, what is on the van, what a board is charging — and a record
 * captured at the press would stop moving the moment it was opened.
 */
export function showItem(ui, itemId) {
  const it = ui.itemById(itemId);
  if (!it) { ui.closePanel(); return; }

  ui.openPanel = 'item';
  // How many one press of the buy verb orders, and it lives here rather than on
  // the server for the reason `_fxTab` does: it is a thing about the menu you
  // have open, not about the shop. Reset on the way IN to a different item —
  // `tickItem` re-opens this same menu on every van, price and shelf that
  // moves, so a reset written unconditionally would put the number back to six
  // under your finger a second after you had set it to thirty.
  if (ui._imRef !== itemId) ui._imQty = ORDER_STEP;
  ui._imRef = itemId;
  // Neither a fixture nor a hire, so nothing in the world is marked — but the
  // rail stays lit on the supplier, because that is where this menu is: you are
  // one press inside a list rather than somewhere else entirely.
  ui.setFixtureRef(null);
  ui.setWorkerRef(null);
  ui.rail.setOpen('stock');
  // The search box needs nothing said about it: `showPanel` hides it for every
  // menu and `paintSection` turns it back on for the ones that are lists, which
  // is exactly the deal a fixture menu already makes. What is NOT cleared is the
  // query behind it — that is the other half of Back's `keep`: you found this
  // item by typing its name, and the list you go back to is the one you left.
  //
  // One callback, called every snapshot, that redraws only when what this shows
  // has moved. The same hook the fixture and worker menus register.
  ui.panelTick = tickItem;
  ui._imKey = itemSignature(ui, it);

  const rule = ui.state?.orders?.items?.[it.id] ?? {};
  const due = comingByItem(ui).get(it.id) ?? null;
  const crafted = madeIn(ui, it.id);
  const held = ui.heldOf(it.id);
  const shelf = onTheShelf(ui, it.id);
  const price = rule.price ?? shelf ?? null;
  const dropped = (ui.state?.orders?.notStocking ?? []).find((d) => d.itemId === it.id) ?? null;
  const qty = ui._imQty ?? ORDER_STEP;

  // Three regions, like a hire's: what this thing IS stays at the top, what you
  // can do to it stays at the bottom, and the decisions scroll between them.
  const parts = [`<div class="pnl-head">${facts(ui, it, {
    held, due, shelf, price, crafted,
  })}</div>`];

  const mid = [];

  /**
   * WHAT YOU CHARGE — first, because it is the one number here that is about
   * money going the other way.
   *
   * `–` means nobody has said: every board that opens takes the shop's own
   * suggestion, which moves with the season and with whatever the world is
   * doing. Setting a price freezes that for this item everywhere, now and on
   * every board opened afterwards, which is the whole of what it buys and also
   * its cost — hence the Auto press beside it, which is how you hand the
   * decision back rather than leaving a number you typed in a heatwave sitting
   * there in the autumn.
   */
  mid.push(setRow({
    act: 'price',
    label: 'Price',
    sub: rule.price != null
      ? 'yours — every board of it, and every new one'
      : 'the shop is pricing this one for you',
    value: price != null ? money(price) : '–',
    unset: rule.price == null,
    // Only where there is something to hand back: on an item nobody has priced,
    // a button whose whole job is to clear a price is a button that does
    // nothing, drawn next to the number it would not have changed.
    clear: rule.price != null ? { act: 'price0', label: 'Auto' } : null,
  }));

  /**
   * ...AND HOW MANY YOU WANT, which is the number the panel never had.
   *
   * `×6` is one press and was also the whole of what a press could say, so the
   * only way to order thirty was five presses — and until the row learned to
   * keep buying (see `sections.js`) it was not even that, because the second
   * press turned into Cancel. "I can only order one bunch of something" is how
   * that reads from a chair.
   *
   * It is a stepper rather than a typed number for the reason the rest of this
   * menu is: 34px squares are a target you can hit with a thumb. And it is the
   * same six the row buys, so the two controls agree about what a case is —
   * this one just says how many cases.
   *
   * The cost is the caption rather than a second figure, because it is the
   * number you are actually deciding on: `×30` means nothing next to a till
   * with $48 in it until it says $43.20.
   *
   * Not offered on a dropped item — its verb is Stock, and an amount beside a
   * button that does not take one is a control that moves no number.
   */
  if (!dropped) {
    mid.push(setRow({
      act: 'qty',
      label: 'Order',
      sub: `${money((it.base_cost ?? 0) * qty)} on the next van, onto the bay`,
      value: qty,
    }));
  }

  // Nothing orders a made-here item and nothing chooses it for a bare board
  // (`pickItem` excludes every recipe output), so a minimum, a maximum and a
  // may-they-order are three controls that would take a press and move no
  // number — which is worse than their absence, because it reads as a shop
  // ignoring an instruction you gave it. The price above is not one of those:
  // a toastie is sold like anything else.
  if (!crafted) {
    mid.push('<div class="sep">What the crew do about it</div>');
    mid.push(setRow({
      act: 'min',
      label: 'Keep at least',
      sub: 'orders come forward while the shop holds fewer',
      value: rule.min ?? '–',
      unset: rule.min == null,
    }));
    mid.push(setRow({
      act: 'max',
      label: 'Never more than',
      sub: 'counted across every shelf, plus what is on the van',
      value: rule.max ?? '–',
      unset: rule.max == null,
    }));
    const auto = rule.auto !== false;
    mid.push(`<div class="im-set">
      <div class="im-what"><b>Crew may order it</b><span>${auto
    ? 'they buy it when the shop runs low'
    : 'they never buy it — you order it yourself'}</span></div>
      <button class="im-tog ${auto ? 'on' : 'off'}" data-act="auto"
        aria-label="crew may order ${esc(it.name)}">${auto ? ICONS.supplier : ICONS.close}
        <i>${auto ? 'Yes' : 'No'}</i></button>
    </div>`);
  }

  parts.push(`<div class="pnl-mid">${mid.join('')}</div>`);

  // ---- the foot: the two verbs that are about right now ---------------------
  const foot = [];
  // Back first and on the left, where a back button goes. It is the only one of
  // these that is not about the item at all — this menu is a drill-down into a
  // list, unlike a fixture's, which you opened by pointing at the thing itself.
  foot.push(actIcon('back', ICONS.supplier, 'Back to the supplier',
    'The whole list again, where you left it.', 'Back'));

  if (dropped) {
    // The shop gave up on this one. Offered here for the reason the row offers
    // it: showing a decision you did not make and withholding the undo is worse
    // than not showing it.
    foot.push(actIcon('again', ICONS.label, 'Stock it again',
      `Your crew stopped stocking ${it.name} — nothing was selling. Puts it back on the list now.`,
      'Stock'));
  } else {
    // A made-here item orders like anything else — the van sells everything
    // again (`Game.buyStock`), so the guard that used to stand here would be
    // the menu withholding a press the shop honours. What stays behind the
    // `crafted` test is the block above: a minimum, a maximum and a
    // may-they-order are still three controls that would move no number,
    // because the crew go on leaving these to the kitchen.
    //
    // **BOTH, not one or the other.** Cancel took the slot outright while
    // anything was on its way, which is what the supplier's row did and is the
    // same bug: ordering more of a thing already coming is the commonest press
    // there is — it is how you notice a van is bringing six and the shelf wants
    // twenty — and it was the one press neither control offered. This is a
    // five-square verb strip, so there is room for the undo to sit beside the
    // verb rather than in front of it. What is already loaded is still not
    // offered, because `cancelOrder` refuses it and a control the shop will
    // refuse is the green-ghost bug wearing a price.
    const inbound = due?.qty ?? 0;
    if (inbound > 0 && !(due?.legs ?? []).every((l) => l.onVan)) {
      foot.push(actIcon('cancel', ICONS.close, 'Cancel the order',
        'It has not left the depot yet, so the money comes back.', 'Cancel', { danger: true }));
    }
    const cost = (it.base_cost ?? 0) * qty;
    foot.push(actIcon('buy', ICONS.crate, `Order ${qty}`,
      `${qty} on the next van, onto the delivery bay.`, `×${qty}`,
      { off: (ui.state?.cash ?? 0) < cost, right: money(cost) }));
  }

  parts.push(`<div class="pnl-foot"><div class="fx-verbs">${foot.join('')}</div></div>`);

  // Keyed on the item, so nudging a number holds your place in the menu and
  // opening a different item does not.
  // The name, then what the world currently thinks of it — the same order the
  // supplier's rows put them in, so the pill means the same thing in the title
  // bar that it means in the list you pressed to get here.
  ui.showPanel(`${esc(it.name)}${ui.heatPill(it)}`, parts.join(''), `item:${it.id}`);
  wireItemMenu(ui, it, { price, qty });
}

/**
 * One decision: what it is, what it means, and two presses either side of the
 * number.
 *
 * The steppers are 34px squares rather than the fifteen they were on the row,
 * which is the whole point of this menu existing — a target that size is a
 * target you can hit with a thumb without zooming, and it costs nothing here
 * because the row is not also carrying a name, a caption and a buy button.
 */
function setRow({ act, label, sub, value, unset = false, clear = null }) {
  return `<div class="im-set">
    <div class="im-what"><b>${esc(label)}</b><span>${esc(sub)}</span></div>
    ${clear ? `<button class="im-clear" data-act="${clear.act}">${esc(clear.label)}</button>` : ''}
    <div class="im-step">
      <button data-act="${act}-" aria-label="less ${esc(label)}">−</button>
      <b${unset ? ' class="none"' : ''}>${value}</b>
      <button data-act="${act}+" aria-label="more ${esc(label)}">+</button>
    </div>
  </div>`;
}

/**
 * The read-out at the top: what this thing is worth, and where it is.
 *
 * Margin rather than the two prices on their own, because that is the number
 * the decision underneath is actually about — "$1.40 in, $2.90 out" is a
 * subtraction the player should not be doing in their head while pressing a
 * stepper that changes one of the two.
 */
function facts(ui, it, { held, due, shelf, price, crafted }) {
  const line = (label, value, hint = null) => `<div class="fx-line"${
    hint ? ` title="${esc(hint)}"` : ''}><span>${esc(label)}</span><b>${value}</b></div>`;
  const cost = it.base_cost ?? 0;
  const sell = price ?? shelf ?? null;
  // A made-here item has a wholesale price like anything else and you can spend
  // it now (`Game.buyStock`), so both figures are true of it — the menu draws
  // the appliance line as well rather than instead. Which is also the honest
  // shape of the decision the graph is built on: what the van charges next to
  // what the shelf takes is the number your own kitchen is competing with.
  const margin = sell != null ? sell - cost : null;
  const inbound = due?.qty ?? 0;
  // The thing itself, beside the figures rather than over them: this menu is
  // reached by pressing a row that already showed you the picture, so its job
  // here is to say you are still looking at the same item — which is a glance,
  // not a headline. Bigger than the row's because there is one of it.
  const art = artForModel(it.model);
  return `<div class="fx-detail im-head">
    ${art ? `<span class="im-art">${art}</span>` : ''}
    <div class="im-figures">
    ${line('On the shelves', `${held || '<i class="none">–</i>'}${
  inbound ? `<i class="coming">+${inbound}</i>` : ''}`)}
    ${crafted
    ? line('Made in', esc(crafted),
      `Made in the ${crafted}, or ordered from the supplier.`)
    : ''}
    ${line('Costs you', money(cost))}
    ${margin != null ? line('Margin', `${money(margin)}${
  cost > 0 ? ` <i class="im-pct">${Math.round((margin / cost) * 100)}%</i>` : ''}`) : ''}
    ${inbound ? line('On the way', esc(comingWhy(due))) : ''}
    ${it.tags?.length ? `<div class="im-tags">${esc(it.tags.join(' · '))}</div>` : ''}
    </div>
  </div>`;
}

/**
 * Every press in the menu.
 *
 * `price` is what the stepper is showing — a price you set, else what a board
 * is charging — so a nudge starts from the number under your finger rather than
 * from `base_price`, which on a shop mid-heatwave is a step backwards before
 * the step you asked for.
 */
function wireItemMenu(ui, it, { price, qty }) {
  const send = (patch) => ui.net.send('item-rule', { itemId: it.id, ...patch });
  const stack = it.stack ?? 12;
  const rule = ui.state?.orders?.items?.[it.id] ?? {};
  // Down off 1 clears it, and unset jumps somewhere useful rather than to 1 —
  // the same two rules the row's steppers had, because they are the reason
  // those numbers are usable at all: twenty presses to reach a sensible maximum
  // is a control nobody touches twice.
  const less = (now) => (now > 1 ? now - 1 : null);
  const more = (now, first) => (now ? now + 1 : first);

  const acts = {
    price: (dir) => {
      const now = price ?? it.base_price ?? 0;
      send({ price: Math.max(0, round2(now + priceStep(now) * dir)) });
    },
    price0: () => send({ price: null }),
    auto: () => send({ auto: rule.auto === false ? null : false }),
  };

  ui.el.panelBody.querySelectorAll('[data-act]').forEach((el) => {
    el.onclick = () => {
      const a = el.dataset.act;
      // `keep`, or coming back costs you the tab, the aisle, the search and the
      // frozen order — the row you pressed would have moved by the time you were
      // looking at the list again, which is the one thing the supplier's freeze
      // exists to prevent.
      if (a === 'back') { ui.showSection('stock', { keep: true }); return; }
      if (a === 'buy') { ui.net.send('buy-stock', { itemId: it.id, qty }); return; }
      // The amount is the menu's own, so nothing is sent and nothing waits for
      // a snapshot: redraw from here, the way `showItem` redraws itself on a
      // tick. Down off the step clears back to one case rather than to nothing
      // — there is no unset amount, because the verb beside it always orders
      // something.
      if (a === 'qty+') { ui._imQty = qty + ORDER_STEP; showItem(ui, it.id); return; }
      if (a === 'qty-') {
        ui._imQty = Math.max(ORDER_STEP, qty - ORDER_STEP);
        showItem(ui, it.id);
        return;
      }
      if (a === 'cancel') { ui.net.send('cancel-order', { itemId: it.id }); return; }
      if (a === 'again') { ui.net.send('stock-again', { itemId: it.id }); return; }
      if (a === 'price+') { acts.price(1); return; }
      if (a === 'price-') { acts.price(-1); return; }
      if (a === 'price0') { acts.price0(); return; }
      if (a === 'auto') { acts.auto(); return; }
      if (a === 'min+') { send({ min: more(rule.min ?? null, Math.max(1, Math.ceil(stack * 0.25))) }); return; }
      if (a === 'min-') { send({ min: less(rule.min ?? null) }); return; }
      if (a === 'max+') { send({ max: more(rule.max ?? null, stack) }); return; }
      if (a === 'max-') send({ max: less(rule.max ?? null) });
    };
  });
}

/**
 * Keep the open menu honest from the snapshot: another player can reprice this
 * from a shelf, a van can land, the crew can give up on it, and the item itself
 * can be deleted out of the content database while you are looking at it.
 */
function tickItem(ui) {
  if (ui.openPanel !== 'item' || !ui._imRef) return;
  const it = ui.itemById(ui._imRef);
  if (!it) { ui.closePanel(); return; }
  if (itemSignature(ui, it) !== ui._imKey) showItem(ui, ui._imRef);
}

/**
 * Everything the menu draws from, so it redraws when any of it moves — and only
 * then, rather than ten times a second over a live canvas.
 *
 * What is deliberately NOT in it is `in` — seconds still to wait on an order,
 * which moves every tick and is printed nowhere: the head says the hour. The
 * supplier's own signature makes the same omission and says why.
 */
function itemSignature(ui, it) {
  const o = ui.state?.orders ?? {};
  const van = (o.pending ?? []).filter((p) => p.item_id === it.id)
    .map((p) => `${p.qty}@${p.at}${p.onVan ? '!' : ''}`);
  const boards = (ui.state?.shelves ?? []).flatMap((s) => (s.stacks ?? [])
    .filter((k) => k.item_id === it.id).map((k) => `${k.qty}@${k.price}`));
  return JSON.stringify([
    it.id, it.name, it.base_cost, it.base_price,
    o.items?.[it.id] ?? null,
    (o.notStocking ?? []).find((d) => d.itemId === it.id)?.left ?? null,
    van, boards, ui.heatFor(it),
    // The buy verb is priced against the till and greys out when you cannot
    // afford what it is set to. Rounded, or every sale in the shop redraws this
    // panel. The amount itself is not in here on purpose: it is the menu's own
    // number, so the press that moves it redraws from the handler — a snapshot
    // is never what tells you it changed.
    Math.floor(ui.state?.cash ?? 0),
    ui.catalog.version,
  ]);
}
