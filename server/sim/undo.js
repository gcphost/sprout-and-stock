/**
 * TAKING IT BACK.
 *
 * Build mode is the one part of this game where a single press can cost real
 * money and be hard to reverse by hand — a wall drag across the wrong aisle is
 * eight segments to knock back out at half the money each, and a shelf dropped
 * one tile over has to be found, lifted and re-aimed. Everything else the
 * player does is either free (walking, pointing) or a decision the shop lives
 * with (buying stock). So undo is scoped to construction and to nothing else.
 *
 * ## It is a stack of DIFFS, not a stack of shops
 *
 * The tempting shape is a snapshot: the building is `placements`, `edits`,
 * `ground` and `paint`, all four are plain data, and restoring them is one
 * assignment each. It is wrong for one reason, and the reason is goods. A
 * fixture's stock does not live on its placement — it lives on the layout
 * record, keyed by an id that `repositionFixture` re-mints every time anything
 * moves. Restore the array and the shelf comes back at its old id with the
 * stock still filed under the new one, which is a shop that is quietly poorer
 * with nothing anywhere to say so. That is the failure this file exists to not
 * have.
 *
 * So a step records what CHANGED, and undoing it walks each change back through
 * the same paths the player's own presses use — `repositionFixture` for a
 * fixture that is still standing (which carries its contents across by alias,
 * because that is what it is for), and a direct write for the three overlays,
 * which hold no goods and therefore cannot lose any.
 *
 * ## The money is reversed exactly, and that is a decision
 *
 * The honest-looking alternative is to let the inverse verbs charge normally:
 * undoing a purchase sells the shelf back at `FIXTURE_REFUND` and you are out
 * half its price. That reads as a fine for mis-clicking, and a undo you cannot
 * afford to use is not an undo. So a step banks the cash it moved and the undo
 * moves exactly the negative of it — as a DELTA and never as a restored
 * balance, or undoing a wall you drew this morning would also hand back a day's
 * takings.
 *
 * There is no arbitrage in that, because the stack is strict: every undo is
 * followed either by a redo that costs exactly what the undo paid back, or by a
 * new action that clears the redo stack. You can only ever return to a
 * (building, cash) pair you have already stood in.
 *
 * ## Only a PRESS is a step
 *
 * `recordUndo` writes nothing unless a step is open, and the only thing that
 * opens one is a build message from a real client (`server/rooms/shop.js`). So
 * the generator's own placements, the balance bot's sixty days of shopping, the
 * MCP surface and every `verify:*` sweep record nothing at all — which is both
 * the memory answer and the right answer, since none of those is somebody
 * pressing a button they wish they hadn't.
 *
 * ## One stack, not one per player
 *
 * There is one shop, two people can be building in it, and the thing you most
 * want to undo when co-op goes wrong is the wall your mate just drew across the
 * door. A per-player stack would refuse exactly that. The log line names the
 * step, so what came back is always said out loud.
 *
 * Not persisted, deliberately: an undo stack that outlived a restart would be
 * offering to reverse a shop you last saw a week ago, and the entries hold ids
 * that a reload has re-minted anyway.
 */

import { canPlace } from '../../shared/build.js';

/**
 * How far back it goes.
 *
 * A cap rather than no cap, because a long building session is thousands of
 * presses and each ground stroke holds up to 256 cells. Deep enough that
 * nobody reaches the end by accident and shallow enough that the stack is a
 * rounding error beside the shop it describes.
 */
export const UNDO_MAX = 60;

const round2 = (v) => Math.round(v * 100) / 100;

/** A placement without its id — what it takes to build this thing again. */
export function specOf(placement) {
  if (!placement) return null;
  const { id, ...rest } = placement;
  return JSON.parse(JSON.stringify(rest));
}

/**
 * Run `fn` as one undoable press.
 *
 * Nested calls join the step that is already open rather than opening another,
 * which is `holdReflow`'s rule and is here for the same reason: a conveyor run
 * is one drag that calls `placeFixture` twelve times, and twelve undo entries
 * for one gesture would mean twelve presses of Ctrl+Z to take back one press of
 * the mouse.
 *
 * A step that changed nothing is dropped rather than pushed. Otherwise every
 * refused press — a wall you could not afford, a shelf on an occupied tile —
 * would sit at the top of the stack as an undo that does nothing, and the one
 * after it would be the one you actually wanted.
 */
export function undoStep(game, label, fn) {
  if (game.undoOpen) return fn();
  game.undoOpen = {
    label,
    parts: [],
    cash: game.cash,
    spent: game.stats?.spent ?? 0,
  };
  try {
    return fn();
  } finally {
    const step = game.undoOpen;
    game.undoOpen = null;
    if (step.parts.length) {
      step.cashAfter = game.cash;
      step.spentAfter = game.stats?.spent ?? 0;
      game.undoStack.push(step);
      if (game.undoStack.length > UNDO_MAX) game.undoStack.shift();
      // A new action is what makes a redo meaningless: the future it was
      // offering to restore is not this shop's future any more.
      game.redoStack.length = 0;
    }
  }
}

/** Note one change, if anybody is listening. See the header: usually nobody is. */
export function recordUndo(game, part) {
  if (game.undoOpen) game.undoOpen.parts.push(part);
}

// ---------------------------------------------------------------------------
// Putting one part back
// ---------------------------------------------------------------------------

/**
 * Build a fixture that is not there any more.
 *
 * Deliberately NOT `placeFixture`: that verb is a purchase, so it checks build
 * mode, mints tier 1, charges the catalog price and writes a line in the feed
 * about a shelf you did not just buy. An undo is none of those things — the
 * money is settled at the step level, and what has to come back is the
 * placement exactly as it stood, tier, variant, `boh` and every conveyor
 * setting included.
 */
function putBack(game, spec, ignore = null) {
  const placement = { ...spec, id: `fx-${game.nextFixtureId}` };
  const check = canPlace(game.layout, placement, { ignoreId: ignore });
  if (!check.ok) return { ok: false, error: check.reason };
  game.nextFixtureId++;
  game.placements.push(placement);
  game.regenerateLayout();
  return { ok: true, id: placement.id };
}

/**
 * ...and take one away again.
 *
 * `removeFixture`'s two refusals and neither of its side effects: no refund, no
 * feed line, no build-mode gate — you may press Ctrl+Z with the palette down.
 * The refusals stay because they are about the world rather than about the
 * press: a shelf somebody has stocked in the meantime must not take the goods
 * with it, and a shop with no till cannot take money.
 */
function takeAway(game, id) {
  const f = id ? game.findFixture(id) : null;
  if (!f) return { ok: false, error: 'that fixture is gone' };
  if (game.fixtureContents(f) > 0) return { ok: false, error: 'there is stock in it now' };
  if (f.kind === 'checkout' && game.layout.checkouts.length <= 1) {
    return { ok: false, error: 'you need at least one till to take money' };
  }
  game.placements = game.placements.filter((pl) => pl.id !== id);
  for (const pl of Object.values(game.players)) {
    if (pl.holding?.id === id) pl.holding = null;
  }
  game.regenerateLayout();
  return { ok: true };
}

/**
 * Move a fixture part to one end of itself.
 *
 * The three cases a fixture part can be in are one sentence: `null` means it
 * was not there, so go and remove it; anything else means it was there, so
 * either turn the one still standing into it (which keeps its stock) or put it
 * back from nothing.
 *
 * `part.id` is rewritten on the way through, because both paths mint a fresh
 * id and the entry has to still name the right thing when the redo comes.
 */
function goTo(game, part, target, ignore = null) {
  if (!target) return takeAway(game, part.id);
  const standing = part.id ? game.findFixture(part.id) : null;
  if (standing) {
    const res = game.repositionFixture(part.id, target, { ignore });
    if (res.ok) part.id = res.id;
    return res;
  }
  const res = putBack(game, target, ignore);
  if (res.ok) part.id = res.id;
  return res;
}

/**
 * Would that work? Asked of every part BEFORE any of them moves.
 *
 * A step can hold twelve fixtures — a conveyor run is one press — and half an
 * undo is worse than none: you would be left with a shop that is neither what
 * you had nor what you asked for, and no entry on the stack to try again with.
 * Every refusal in here is a real thing that can happen between the press and
 * the Ctrl+Z: somebody stocked the shelf, a wall went up across the tile, the
 * fixture was torn out by the other player.
 */
function couldGoTo(game, part, target, ignore = null) {
  if (!target) {
    const f = part.id ? game.findFixture(part.id) : null;
    if (!f) return 'that fixture is gone';
    if (game.fixtureContents(f) > 0) return 'there is stock in it now';
    if (f.kind === 'checkout' && game.layout.checkouts.length <= 1) {
      return 'you need at least one till to take money';
    }
    return null;
  }
  const standing = part.id ? game.findFixture(part.id) : null;
  const probe = { ...target, id: standing ? part.id : `fx-${game.nextFixtureId}` };
  const check = canPlace(game.layout, probe, { ignoreId: ignore ?? (standing ? part.id : null) });
  return check.ok ? null : check.reason;
}

/** Write one overlay entry back, or take it out if there never was one. */
function setEdge(game, seg, entry) {
  const key = `${seg.o}:${seg.x},${seg.z}`;
  game.edits = game.edits.filter((e) => `${e.o}:${e.x},${e.z}` !== key);
  if (entry) game.edits.push({ ...entry });
}

function setGround(game, cell, entry) {
  const key = `${cell.x},${cell.z}`;
  game.ground = game.ground.filter((f) => `${f.x},${f.z}` !== key);
  if (entry) game.ground.push({ ...entry });
}

function applyPart(game, part, dir, ignore = null) {
  const target = dir === 'undo' ? part.from : part.to;
  if (part.t === 'fixture') return goTo(game, part, target, ignore);
  if (part.t === 'edges') {
    for (const s of part.segs) setEdge(game, s, dir === 'undo' ? s.was : s.now);
    game.regenerateLayout();
    return { ok: true };
  }
  if (part.t === 'ground') {
    for (const c of part.cells) setGround(game, c, dir === 'undo' ? c.was : c.now);
    game.regenerateLayout();
    return { ok: true };
  }
  if (part.t === 'paint') {
    const next = { ...game.paint };
    for (const f of part.faces) {
      const want = dir === 'undo' ? f.was : f.now;
      if (want) next[f.key] = want;
      else delete next[f.key];
    }
    game.paint = next;
    // The same line `paintFaces` ends on, and for the same reason: the live
    // layout carries the overlay so a client joining mid-session gets it, and
    // paint deliberately does not re-flow.
    game.layout.paint = { ...game.paint };
    return { ok: true };
  }
  return { ok: true };
}

function couldApply(game, part, dir, ignore = null) {
  if (part.t !== 'fixture') return null;
  return couldGoTo(game, part, dir === 'undo' ? part.from : part.to, ignore);
}

/**
 * EVERY FIXTURE IN THIS STEP THAT IS ABOUT TO LEAVE WHERE IT STANDS.
 *
 * One press can move several units at once (`shiftFixtures`), and every check in
 * here runs against `game.layout` — which under the `holdReflow` below is the
 * shop as it stood before the first part moved. So an aisle put back one square
 * along has each member refused for standing in the way of the neighbour it is
 * about to replace, and because half an undo is worse than none, the WHOLE step
 * is refused. Nothing is wrong with any of it: press Ctrl+Z on a move you just
 * made and the shop says "something is already there" about the shop you asked
 * it to go back to.
 *
 * Which is exactly the question `ignores` (shared/build.js) answers for the
 * press itself, so it is answered the same way here. Only the parts that
 * actually change TILE are forgiven: a part standing still — a restyle, a rung —
 * is not leaving, and forgiving it would let another part land on top of it.
 */
function movingIds(order, dir) {
  const out = new Set();
  for (const p of order) {
    if (p.t !== 'fixture' || !p.id) continue;
    const now = dir === 'undo' ? p.to : p.from;
    const then = dir === 'undo' ? p.from : p.to;
    if (!now || !then || now.x !== then.x || now.z !== then.z) out.add(p.id);
  }
  return out;
}

/**
 * Walk one step back, or forward.
 *
 * The shape is the same in both directions, which is the whole reason this is
 * one function: a redo is an undo of an undo, and two implementations of that
 * would be two places for the money to be reversed slightly differently.
 *
 * Order matters and is the mirror of itself: undone in reverse, redone in the
 * order it happened. A conveyor run laid west to east has to come up east to
 * west, or the third cell is removed while the fourth still names it.
 */
function walk(game, dir) {
  const from = dir === 'undo' ? game.undoStack : game.redoStack;
  const to = dir === 'undo' ? game.redoStack : game.undoStack;
  const step = from[from.length - 1];
  if (!step) return { ok: false, error: dir === 'undo' ? 'nothing to undo' : 'nothing to redo' };

  const order = dir === 'undo' ? [...step.parts].reverse() : step.parts;
  // Read once, before anything moves — the ids are re-minted as the walk goes,
  // and what has to be forgiven is where each of them is standing NOW.
  const moving = movingIds(order, dir);
  for (const part of order) {
    const why = couldApply(game, part, dir, moving);
    if (why) return { ok: false, error: why };
  }

  // The money first, so nothing inside the walk can be refused for want of it,
  // and again at the end, so whatever the parts did to the balance is
  // discarded. Neither path spends anything today; both are here because the
  // day one of them does, the reversal has to stay exact.
  const dCash = round2(step.cashAfter - step.cash);
  const dSpent = round2(step.spentAfter - step.spent);
  const cash = round2(game.cash + (dir === 'undo' ? -dCash : dCash));
  const spent = round2((game.stats?.spent ?? 0) + (dir === 'undo' ? -dSpent : dSpent));
  game.cash = cash;

  let failed = null;
  game.holdReflow(() => {
    for (const part of order) {
      const res = applyPart(game, part, dir, moving);
      if (!res.ok) failed ??= res.error;
    }
  });
  game.cash = cash;
  if (game.stats) game.stats.spent = spent;

  from.pop();
  to.push(step);
  game.persist();

  const moved = dir === 'undo' ? -dCash : dCash;
  const money = moved > 0.005 ? ` — $${moved.toFixed(2)} back.`
    : moved < -0.005 ? ` — $${(-moved).toFixed(2)}.`
      : '.';
  game.pushLog(`${dir === 'undo' ? 'Undid' : 'Redid'}: ${step.label}${money}`);

  return {
    ok: true,
    label: step.label,
    cash: round2(moved),
    // What the room has to send on. Paint is the one build verb that never
    // re-flows, so a step made only of paint would otherwise come back with
    // nothing on screen having changed.
    layout: step.parts.some((p) => p.t !== 'paint'),
    paint: step.parts.some((p) => p.t === 'paint'),
    error: failed,
    undos: game.undoStack.length,
    redos: game.redoStack.length,
  };
}

export const undoLast = (game) => walk(game, 'undo');
export const redoLast = (game) => walk(game, 'redo');
