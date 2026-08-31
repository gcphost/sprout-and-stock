/**
 * A LOT — some goods, of more than one kind, in one place.
 *
 * Two things in this game hold stock without being furniture: a pair of hands
 * (`p.carry`), and a crate on the floor (`deliveries[]`). Both were
 * `{ item_id, qty }` — one kind, one number — and that single field is why a
 * four-crop harvest became four crates on four cells, and why emptying one of
 * them by hand was one walk to the shelves per kind.
 *
 * A shelf has never had that problem: it holds several kinds, one per board,
 * capped by how many boards its art draws. So a lot is a shelf's `stacks` said
 * about a thing you can pick up — the SAME shape (`{ item_id, qty }[]`), so the
 * renderer, the snapshot and every "what is in there" reader already know how
 * to read it.
 *
 * ## The two caps, and why there are two
 *
 * `cap` is how many UNITS fit — hands hold six, a crate holds twelve — and it
 * is the number that was already there. `kinds` is new and is the one that
 * stops mixing from eating the game: without it a single crate absorbs the
 * whole yard, and how big you painted the pad stops meaning anything (the note
 * on `dropGoods` has been warning about a merge that swallows a delivery since
 * before crates could mix). A shelf spells the same cap `shelfBoards`, and
 * reads it off the art; a crate has no art per kind, so it is a constant.
 *
 * ## Empty is null, on purpose
 *
 * A lot with nothing in it is `null`, never `{ stacks: [] }`. Dozens of
 * readers ask `if (p.carry)` meaning "am I holding anything", and an empty
 * object is truthy — every one of them would have started answering yes to
 * empty hands, silently, and the tell would be a shop where nobody can pick
 * anything up. `lotTake` returns null when it empties something for that
 * reason, and every writer here goes through `norm`.
 *
 * ## The old shape still reads
 *
 * `lotStacks` accepts `{ item_id, qty }` and answers with one stack. That is a
 * read-time default rather than a migration — the same call `kindOf` makes
 * about a `fixtures` row with no `kind` — so a save written before this, an
 * export, and a fresh seed all agree with no ceremony, and a shop somebody is
 * mid-game in does not lose the crate on their shoulder.
 */

/**
 * How many different things one pair of hands or one crate holds.
 *
 * Three, matching what a mid-tier shelf draws boards for. It is a judgement
 * rather than a measurement, and what it defends is the picture: `buildPallet`
 * stands a sample of each kind in the box, and a box showing six samples is a
 * box you cannot read at this camera pitch. It is also what keeps a crate a
 * *trip* rather than a container — mixing is meant to save you journeys, not
 * turn the yard into one box.
 */
export const LOT_KINDS = 3;

/**
 * Drop empties, and collapse a lot with nothing left in it to null.
 *
 * Spreads rather than rebuilding from `item_id`/`qty`, so a field somebody else
 * hung on a stack survives every operation in this file. That is not tidiness:
 * a crate's spoilage clock (`day`) lives on the STACK, because a mixed box
 * holds a fortnight-old pallet of flour beside this morning's lettuce and one
 * stamp on the box cannot say both. Rebuilding the pair would strip it, and
 * what you would see is a yard that never rots — which is the exact hole
 * spoilage was extended to the yard to close.
 */
function norm(stacks) {
  const kept = stacks.filter((s) => s && s.item_id && s.qty > 0)
    .map((s) => ({ ...s, qty: Math.round(s.qty) }));
  return kept.length ? { stacks: kept } : null;
}

/**
 * What is in it, as a list.
 *
 * The one reader everything else here is built on, and the one place the old
 * single-kind shape is understood. Never hands back the lot's own array — a
 * caller that sorted the result would be reordering somebody's hands.
 */
export function lotStacks(lot) {
  if (!lot) return [];
  if (Array.isArray(lot.stacks)) {
    return lot.stacks.filter((s) => s && s.item_id && s.qty > 0).map((s) => ({ ...s }));
  }
  // The old single-kind shape, read as one stack. `day` comes across with it,
  // which is what lets a crate saved before this keep the spoilage clock it was
  // already carrying on the box.
  if (lot.item_id && lot.qty > 0) {
    return [{ item_id: lot.item_id, qty: lot.qty, ...(lot.day != null ? { day: lot.day } : {}) }];
  }
  return [];
}

/** How much is in it altogether — what `cap` is measured against. */
export function lotTotal(lot) {
  return lotStacks(lot).reduce((n, s) => n + s.qty, 0);
}

/** How many different things are in it — what `kinds` is measured against. */
export function lotKinds(lot) {
  return lotStacks(lot).length;
}

/** How much of one particular thing is in it. */
export function lotQty(lot, itemId) {
  return lotStacks(lot).find((s) => s.item_id === itemId)?.qty ?? 0;
}

/** Is any of this thing in it at all? */
export function lotHas(lot, itemId) {
  return lotQty(lot, itemId) > 0;
}

/**
 * The one kind that best stands for the whole lot.
 *
 * For the places that have to name a single thing and always did: the HUD line,
 * the chevrons pointing at shelves that would take what you are holding, a
 * gesture that did not name a kind. The BIGGEST stack rather than the first,
 * because the order stacks went in is not a fact anybody can see, and "you are
 * carrying mostly tomatoes" is the sentence a glance at your own arms makes.
 */
export function lotMain(lot) {
  return lotStacks(lot).slice().sort((a, b) => b.qty - a.qty)[0] ?? null;
}

/**
 * How many more of this thing would go in.
 *
 * Both caps at once, which is the whole reason it is a function rather than a
 * subtraction at each call site: room for four units and no free kind slot is
 * room for zero, and a caller that checked only the units would promise a
 * pickup the lot then refuses. `Infinity` is a legal `cap` — that is how the
 * callers that only care about kinds ask.
 */
export function lotRoom(lot, itemId, { cap = Infinity, kinds = LOT_KINDS } = {}) {
  const stacks = lotStacks(lot);
  const units = cap - stacks.reduce((n, s) => n + s.qty, 0);
  if (units <= 0) return 0;
  if (stacks.some((s) => s.item_id === itemId)) return units;
  return stacks.length >= kinds ? 0 : units;
}

/**
 * Put some in, and say how much actually went.
 *
 * Returns a NEW lot rather than mutating, because `p.carry` and a crate's
 * `stacks` are both read straight into the snapshot — a partial mutation seen
 * by a tick mid-flight is a quantity nobody wrote. Callers assign the result.
 *
 * Takes what fits rather than refusing the lot, which is what every existing
 * caller already did with one kind: half an armful onto a board with room for
 * half is a good trip, and only the surplus has nowhere to be.
 */
export function lotAdd(lot, itemId, qty, opts = {}) {
  const add = Math.min(Math.round(qty), lotRoom(lot, itemId, opts));
  if (!(add > 0)) return { lot, added: 0 };
  const stacks = lotStacks(lot);
  const at = stacks.find((s) => s.item_id === itemId);
  if (at) at.qty += add;
  else stacks.push({ item_id: itemId, qty: add });
  return { lot: norm(stacks), added: add };
}

/**
 * Take some out, and say how much actually came.
 *
 * `itemId` null means "whatever is in there", which is what a gesture that did
 * not name a kind means — it drains the biggest stack first, so repeatedly
 * taking from a mixed box levels it rather than emptying it in the order it was
 * filled.
 */
export function lotTake(lot, itemId, qty) {
  const stacks = lotStacks(lot);
  const at = itemId
    ? stacks.find((s) => s.item_id === itemId)
    : stacks.slice().sort((a, b) => b.qty - a.qty)[0];
  if (!at) return { lot, took: 0, item_id: null };
  const took = Math.min(Math.round(qty), at.qty);
  if (!(took > 0)) return { lot, took: 0, item_id: at.item_id };
  at.qty -= took;
  return { lot: norm(stacks), took, item_id: at.item_id };
}

/**
 * Take across kinds until you have as much as you asked for.
 *
 * This is the mixing actually paying for itself: one reach into a box of
 * tomatoes, carrots and eggs comes out with an armful of all three rather than
 * an armful of whichever one was named. `into` is the lot it is going into, so
 * the destination's own two caps bound it — otherwise a sweep off a crate of
 * five kinds fills three slots and drops the rest on the floor.
 *
 * Biggest stack first, for the same reason `lotTake` drains that one: it is the
 * one a glance would have picked, and it levels the box rather than emptying it
 * in arrival order.
 */
export function lotSweep(from, into, qty, opts = {}) {
  let src = from;
  let dst = into;
  let moved = 0;
  for (const s of lotStacks(from).sort((a, b) => b.qty - a.qty)) {
    if (moved >= qty) break;
    const want = Math.min(s.qty, qty - moved, lotRoom(dst, s.item_id, opts));
    if (!(want > 0)) continue;
    const out = lotTake(src, s.item_id, want);
    src = out.lot;
    const in_ = lotAdd(dst, s.item_id, out.took, opts);
    dst = in_.lot;
    moved += in_.added;
  }
  return { from: src, into: dst, moved };
}

/**
 * What to call it in a sentence.
 *
 * `items` is `content().byId.items`. One kind reads as itself; more than one
 * reads as a count, because "6x Tomato, 4x Carrot and 2x Egg" in a refusal
 * message is a sentence nobody finishes reading.
 */
export function lotLabel(lot, items = {}) {
  const stacks = lotStacks(lot);
  if (!stacks.length) return 'nothing';
  if (stacks.length === 1) {
    const s = stacks[0];
    return `${s.qty}x ${items[s.item_id]?.name ?? s.item_id}`;
  }
  return `${lotTotal(lot)} units across ${stacks.length} kinds`;
}

/** A lot holding exactly one thing — how every caller that had one builds it. */
export function lotOf(itemId, qty) {
  return norm([{ item_id: itemId, qty }]);
}

/**
 * IS THIS BOX IN TRANSIT — on a conveyor, or held inside a machine?
 *
 * A fact about where the crate IS rather than about what is in it, which is the
 * one thing in this file that is, and it is here because both readers of it are
 * somewhere else. It is a crate's own field either way (`d.belt` is the cell it
 * is riding, `d.packer` the machine holding it), and it rides the snapshot on
 * the same sparse terms as `waste` — sent only when true, because every crate in
 * every shop that has never built a belt is neither.
 *
 * What it decides is one thing: **a box that is moving wears no caption.** A run
 * of belt was a row of labels gliding past, each legible for about a second and
 * all of them layered over the aisle behind, and reading is the one thing you
 * cannot do to a word that will not hold still. `syncDeliveries` is the only
 * reader today, and it is a named test rather than the two fields written out
 * because the pair means something — "in transit" — that neither field says on
 * its own, and because the next thing to want it will want the same answer.
 *
 * The half that hands the name BACK is the hover card (`setCrateTip`), and it
 * deliberately does not ask this: it is offered for every box, moving or not,
 * because a caption and a card answer two different questions. See its header.
 */
export function crateRides(d) {
  return !!(d && (d.belt || d.packer));
}
