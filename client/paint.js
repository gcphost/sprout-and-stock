/**
 * WRITE HTML ONLY WHEN IT SAYS SOMETHING DIFFERENT.
 *
 * Every live surface in this client is rebuilt from `innerHTML` — a panel, the
 * bottom bar, the rail — and each is already guarded by a signature so it only
 * repaints when the data behind it moves. That is one guard too coarse. A
 * fixture menu's signature carries stock, queues, hands and cash, so a shopper
 * paying at a till two aisles away repaints a menu whose forty rows come out
 * BYTE FOR BYTE the same, and a repaint that changes nothing is not free:
 *
 * - **Hover dies with the node.** The pointer has not moved, but the element
 *   under it has been replaced, and `:hover` is not re-evaluated until the
 *   next mouse move. The button you are pointing at visibly drops out of its
 *   hover state and comes back — a flicker in time with the snapshot, worst on
 *   the rows that update most, which are the ones you hover.
 * - **The tooltip goes with it** — see `orphan` in client/tip.js, which is the
 *   same bug caught one layer further out.
 * - So does a caret, a text selection, a `:active` press and a CSS transition
 *   mid-flight.
 *
 * Comparing against the LAST STRING WE WROTE rather than against the element's
 * current `innerHTML`, and that is the non-obvious half: the DOM is not what we
 * put there. `tip.js` moves a `title` onto `data-tip` and removes the attribute
 * the first time you hover something, so the live markup of the one node you
 * are pointing at never matches the string that produced it — which is exactly
 * the node this is trying to leave alone. Serialising the DOM would also cost
 * more than the write it is trying to avoid.
 *
 * Returns whether it wrote, for callers that only need to re-wire when the
 * nodes are new. Re-wiring anyway is safe and most callers do: assigning
 * `onclick` over the same node is a swap, not a leak.
 */

const LAST = new WeakMap();

export function setHtml(el, html) {
  if (!el) return false;
  if (LAST.get(el) === html) return false;
  LAST.set(el, html);
  el.innerHTML = html;
  return true;
}

/**
 * ...and the same for one string of text.
 *
 * `textContent` on an unchanged string is cheaper than the HTML case and still
 * not free: it destroys and rebuilds the text node, which drops a selection
 * inside it. Here so that a caller diffing several readouts does not have to
 * decide which ones are worth the guard.
 */
export function setText(el, text) {
  if (!el || el.textContent === text) return false;
  el.textContent = text;
  return true;
}
