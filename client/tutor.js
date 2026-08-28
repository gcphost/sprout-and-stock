/**
 * THE TUTORIAL — a robot who shows you round, and holds the rest of the game
 * still while it does.
 *
 * The shop is deep and every one of its verbs is a *gesture* — a tap is one
 * unit, a hold is the lot, a right press pours, a drag builds a run — and none
 * of that is discoverable by pressing things. A new shop opens shut, empty and
 * silent, with a rail of eight icons and no reason to press any of them. So this
 * is the one screen in the game that tells you what to do next, and it earns
 * that by being *narrow*: one instruction, one lit target, everything else
 * blacked out and unpressable.
 *
 * Four things about it are load-bearing.
 *
 * **It is entirely client-side.** Nothing here sends a message the game did not
 * already have, nothing here is on the save, and nothing in `server/` knows it
 * exists. That is deliberate rather than lazy: a tutorial is a fact about a
 * *person* rather than about a shop — the second world you make should not
 * explain the walk key again — so it lives in localStorage beside `sns-me` and
 * `sns-name`, and a shop played by two people does not put a veil over the other
 * one's screen.
 *
 * **A step is a PREDICATE, never a press it intercepted.** Every `done` is a
 * question about the snapshot (`state.roster` grew, `p.haul` is set, the
 * shutters went up), so the only way past a step is to actually do the thing —
 * with any gesture, from any menu, including one the step never mentioned. The
 * alternative, watching for the click on the button we lit, is a tutorial that
 * gets stuck the moment somebody uses the keyboard shortcut instead, and one
 * that can be satisfied by a press that failed.
 *
 * **It marks rather than corners you.** There was a blackout here — four boxes
 * round one lit hole, so exactly one press was possible while a card was up.
 * It is gone, and what it was is worth keeping written down, because it is the
 * obvious way to build this: what somebody learns from a tutorial they can only
 * get through one way is *how to get through the tutorial*. The shop is not a
 * corridor and this is the one screen that was treating it like one. So the
 * card marks its target and waits, everything else stays live, and going off to
 * do something else first costs nothing — which the predicates below already
 * allowed for and the blackout was the only thing preventing.
 *
 * **It refuses to block the world.** Every step whose target is a thing standing
 * in the shop — a crate, a shelf, the tile you walk to — lights the canvas
 * whole and marks the target instead. The mark is IN the shop
 * (`Scene.setTutorTarget`, `MARKER_LOOK.tutor`) rather than on the page, and
 * that is the whole of what was wrong with the pulsing circle it replaced: a
 * circle projected through `worldToScreen` every frame tracks its point
 * perfectly and still reads as unpinned, because everything else in the picture
 * turns and foreshortens as the camera comes round and a fixed-size coin does
 * not. A frame on the tile lies on the ground with the tile grid, which is the
 * vocabulary every other marker in the game already speaks.
 *
 * It takes a POINT rather than a fixture, which is what makes one call answer
 * all three: a crate is not a fixture, and the tile you are asked to walk to is
 * not a thing at all, so the renderer's own `setAimTarget` (which wants an `f`)
 * has nothing to hang on for two of the three. And it cannot be the contour
 * every marker uses for a unit, because that mask carries three channels — see
 * `MARK` — and amber, teal and red are all spoken for.
 *
 * The one thing it may never do is trap you. Skip is on every step, Esc skips,
 * and the whole thing can be switched off from the Menu — which is also where
 * you switch it back on, because a tutorial you cannot re-run is a tutorial that
 * punishes the first press.
 */

import { money } from './money.js';
import { pillDrives } from './input.js';
import { REACH, isWalkableTile, insideStore } from '../shared/build.js';

/**
 * The same sentence for each grammar — see `pillDrives`.
 *
 * The tour was written when every verb in the game was a mouse button, and half
 * of what it teaches is *which* button. On a phone there is one, the verbs live
 * on the pill along the bottom, and a tap on something you are stood at asks a
 * question rather than doing anything — so every one of those sentences is not
 * merely clumsy, it names a press that cannot be made. A tutorial that does that
 * is worse than none: the player does exactly what the card says, nothing
 * happens, and the thing they conclude is that the game is broken.
 *
 * Asked at paint time and never at module load, because `say` and `hint` are
 * re-read every frame and a browser window can cross the line mid-tour.
 *
 * The word for the pill is "the bar along the bottom" everywhere in here. It has
 * no name on screen, so the tour is the only thing that can give it one, and two
 * names for it would be two things as far as anybody reading is concerned.
 */
const perInput = (mouse, finger) => (pillDrives() ? finger : mouse);

/** Off for everybody, everywhere. The Menu's switch. */
const OFF_KEY = 'sns-tutor-off';
/** Worlds this browser has finished (or skipped) the tour in. */
const DONE_KEY = 'sns-tutor-done';
/** Worlds this browser MADE, and so believes are new. */
const NEW_KEY = 'sns-tutor-new';
/**
 * ...and whether this person has ever been shown round SOMEBODY ELSE'S shop.
 *
 * One flag rather than a list of worlds, which is the whole difference between
 * this and `DONE_KEY`. The host's tour is about a shop — it teaches you what to
 * do with the one you just made, and a second shop is a second thing to be told
 * about. The guest tour is about a pair of hands: it teaches the four gestures
 * and nothing about anybody's shop, so being walked through it again at the next
 * friend's place is the tutorial nagging somebody who already knows.
 */
const GUEST_KEY = 'sns-tutor-guest';

const read = (k, fallback = null) => {
  try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
};
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

const listOf = (k) => String(read(k, '') ?? '').split(',').filter(Boolean);
const addTo = (k, id) => {
  const had = listOf(k);
  if (!had.includes(id)) write(k, [...had, id].slice(-40).join(','));
};
const dropFrom = (k, id) => write(k, listOf(k).filter((x) => x !== id).join(','));

/** The switch, for the Menu row that draws it. */
export const tutorOff = () => read(OFF_KEY) === '1';
export const setTutorOff = (off) => write(OFF_KEY, off ? '1' : '0');

/**
 * A world this browser has just created.
 *
 * Called by the new-shop form rather than inferred from `day === 1`, because
 * that is also true of a shop somebody made yesterday, closed on the first
 * morning and came back to — and being handed the tutorial again on a shop you
 * have already furnished is the thing that makes people turn tutorials off.
 *
 * It clears the DONE mark as well, and that half is not tidiness. `mintId`
 * slugifies the name and only counts rows that still exist, so deleting a shop
 * frees its id: make another one called the same thing and you get the same
 * string back. It is a brand new save with a second-hand name, and without this
 * it inherits a "already been shown round" mark from the shop you just binned —
 * which presents as the tutorial being broken for new worlds, intermittently,
 * depending on what you called them.
 */
export const markWorldNew = (id) => {
  if (!id) return;
  dropFrom(DONE_KEY, id);
  addTo(NEW_KEY, id);
};

/**
 * ...and one worth doing it in again, which is the Menu's other press.
 *
 * Both marks have to move: `done` is why it would not start, and `new` is why it
 * would. Clearing only the first leaves a Replay button that works once per
 * world and then silently stops.
 */
export const replayTutor = (id) => {
  if (!id) return;
  dropFrom(DONE_KEY, id);
  addTo(NEW_KEY, id);
};

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Looking at the supplier — including one press INTO it.
 *
 * An item has its own menu now (`client/item-menu.js`), and while it is up the
 * open panel is `item` rather than `stock`. Every step that asks "are they in
 * the supplier" means the list *and* the drill-down: both are that menu, and the
 * one press that finishes this step — ordering six — is on both.
 */
const inSupplier = (t) => t.ui.openPanel === 'stock' || t.ui.openPanel === 'item';

/**
 * How high up a thing is, for the mark that points at it.
 *
 * Measured against the art rather than against the tile, because that is what
 * you are looking at: a crate is a box a third of a tile tall sitting on the
 * floor, and a shelf's goods are the thing you are being told to press. Getting
 * these wrong does not look like a wrong number — it looks like a marker that
 * does not know where anything is.
 */
const CRATE_Y = 0.34;
const SHELF_Y = 0.85;

/** Somebody's own body out of the snapshot, or null before the first frame. */
const meOf = (t) => (t.state?.players ?? []).find((p) => p.id === t.net.myId) ?? null;

/** How many units are in an armful or a box, across every pile in it. */
const lotSize = (lot) => {
  if (!lot) return 0;
  if (Array.isArray(lot.stacks)) return lot.stacks.reduce((n, s) => n + (s.qty ?? 0), 0);
  if (Array.isArray(lot)) return lot.reduce((n, s) => n + (s.qty ?? 0), 0);
  return lot.qty ?? 0;
};

/**
 * Every unit of shelving standing in the shop, by kind — AND WHERE IT IS.
 *
 * The snapshot's shelf record is what a shelf is *doing*: its boards, its stock,
 * what it is kept for, what it is called. It has never carried `x` or `z`, and
 * that is correct — where a unit stands only moves on a re-flow, so it rides the
 * layout, on the layout's own clock. `deliveries` and `cashDrops` do carry a
 * position, which is exactly why every crate step in this file worked and every
 * shelf step did not.
 *
 * Read straight through, it fails in the one way nothing catches. `at` hands the
 * marker `{ world: shelf }` and `holeFor` reads `world.x`/`world.z` off it, so a
 * shelf carrying neither hands the renderer an undefined position — a mark that
 * is on screen as far as every flag in here is concerned and is nowhere at all
 * in the picture, with the card sitting beside it saying to look.
 *
 * `dist` took the same road to a different end — `undefined - number` is NaN, so
 * `atIt` was false at every shelf in the shop, for ever. That is the half that
 * wedges rather than misleads: the two-phase shelf steps ask it to decide
 * whether you have arrived, and it can only ever answer no.
 *
 * So the position is married on here, by id, off the layout the renderer is
 * already holding — the same source `spotToWalk` reads, and the same join
 * `Scene.syncShelves` makes for the goods it draws. A unit the layout has not
 * caught up with is DROPPED rather than passed on without a position: "there is
 * no shelf to point at" is a state every step here already copes with (`lost`,
 * and the veil gets out of the way), and a shelf at 0,0 is not.
 */
const shelvesOf = (t, kind = null) => {
  const where = new Map((t.scene?.storeLayout?.shelves ?? []).map((s) => [s.id, s]));
  return (t.state?.shelves ?? [])
    .filter((s) => !kind || s.kind === kind)
    .map((s) => {
      const at = where.get(s.id);
      return at ? { ...s, x: at.x, z: at.z } : null;
    })
    .filter(Boolean);
};

/** The nearest crate of stock on the floor — the one the marker should point at. */
function nearestCrate(t) {
  const me = meOf(t);
  const crates = (t.state?.deliveries ?? []).filter((d) => !d.rubbish && lotSize(d) > 0);
  if (!crates.length) return null;
  if (!me) return crates[0];
  return crates.slice().sort((a, b) => dist(a, me) - dist(b, me))[0];
}

/**
 * Are you stood at it?
 *
 * `REACH`, imported rather than guessed, because this decides which SENTENCE
 * you are shown and the shop decides which MESSAGE your click sends — two
 * numbers would be a card telling you to click for a unit next to a crate the
 * shop is going to answer by walking you two more steps.
 *
 * It used to say "the same constant `inReachOf` uses", and that was never true:
 * main.js keeps THREE distances and says so at length — `inReachOf` is
 * `UNLOAD_REACH` (1.8) for a crate or a square, `nearFixture` is `REACH` (1.6)
 * for a unit, and `atWorkSpotOf` measures to the side you work it from. This is
 * the middle one, so it is exactly right about a shelf and two tenths of a tile
 * tight about a crate. Left tight on purpose: a walk to a crate stops beside it
 * (`beside`), well inside either number, so the band is unreachable in play —
 * and being early with "you are not there yet" is the harmless direction, where
 * being late offers a press the shop refuses.
 */
const atIt = (t, thing) => {
  const me = meOf(t);
  return !!(me && thing && dist(me, thing) <= REACH);
};

/**
 * A shelf to point at — and with something in your hands, one that will TAKE it.
 *
 * `takers` is the shop's own answer to "which units would have what you are
 * holding", worked out server-side off `shelfAccepts` and hung on your own
 * player record. It is what draws the green chevrons, which is to say it is the
 * thing this file's own hint text promises: *"Arrows point at every shelf that
 * will take what you are holding."* Ringing a unit chosen by any other rule is
 * a tour that contradicts the arrows it just told you to read — the green-ghost
 * bug wearing a tutorial marker.
 *
 * The old rule was `kind === 'shelf'` plus "has something on it", which is
 * wrong three ways at once and each of them silently: it could never ring a
 * freezer or a hot counter, so anything frozen was guaranteed to be marked at a
 * unit that refuses it; it read "has stock" as "has room", which is nearly the
 * opposite test; and it never asked what you were carrying at all.
 *
 * The fallback is that old rule exactly, and it has to stay: half the steps that
 * call this ask you to open a shelf's menu rather than to fill it, and with
 * empty hands `takers` is empty — a tour that pointed at nothing there would be
 * a step you cannot start.
 */
function anyShelf(t) {
  const want = new Set(meOf(t)?.takers ?? []);
  const units = shelvesOf(t);
  const takes = units.filter((s) => want.has(s.id));
  if (takes.length) return takes.find((s) => (s.stacks ?? []).length) ?? takes[0];
  const plain = units.filter((s) => s.kind === 'shelf');
  return plain.find((s) => (s.stacks ?? []).length) ?? plain[0] ?? null;
}

/**
 * A tile to send somebody to, a few steps off.
 *
 * "Click a bit of floor" is an instruction with no target, on the one card whose
 * whole job is teaching you that clicking a target is how you get anywhere — so
 * the tour picks one and rings it, the same way it rings a crate.
 *
 * Three things decide the shape. It must be INDOORS: the shop is a small
 * building in a big field, so the first walkable cell four steps out is very
 * often grass, and a tour whose opening move is to send you outside has taught
 * you to leave. It searches outward from a ring at a fixed distance rather than
 * taking the first cell it finds, because a tile one step away is a target you
 * are already standing on. And it is worked out ONCE, in `start`, and held:
 * asked every frame it would re-answer as you moved, so the marker would slide
 * away and the walk would never end.
 *
 * `isWalkableTile` and `insideStore` are the shop's own tests, off the layout
 * the renderer is holding — a ring on a tile the server will refuse to route to
 * is the green-ghost bug wearing a marker.
 */
function spotToWalk(t) {
  const me = meOf(t);
  const L = t.scene?.storeLayout;
  if (!me || !L) return null;
  const from = { x: Math.round(me.x), z: Math.round(me.z) };
  const ok = (x, z) => isWalkableTile(L, x, z) && insideStore(L, x, z);
  // Every cell in the building, furthest first, so the walk is a walk rather
  // than a step — and a shop with no room to cross still answers with whatever
  // it has instead of sending you out of the door.
  let best = null;
  for (let z = 0; z < (L.h ?? 0); z += 1) {
    for (let x = 0; x < (L.w ?? 0); x += 1) {
      if (!ok(x, z)) continue;
      const d = Math.hypot(x - from.x, z - from.z);
      // Far enough to be a journey, near enough to stay on screen.
      if (d < 2.5 || d > 9) continue;
      if (!best || Math.abs(d - 5) < Math.abs(best.d - 5)) best = { x, z, d };
    }
  }
  return best ? { x: best.x, z: best.z } : null;
}

/** How many boards in the whole shop are kept for something. */
const keptCount = (t) => shelvesOf(t)
  .reduce((n, sh) => n + (sh.assigned ?? []).length, 0);

/** The cheapest chiller in the catalogue, so the step lights one you can afford. */
function cheapestFreezer(t) {
  const rows = (t.ui.catalog?.fixtures ?? []).filter((f) => (f.kind ?? f.id) === 'freezer');
  return rows.slice().sort((a, b) => (a.cost ?? 1e9) - (b.cost ?? 1e9))[0] ?? null;
}

/**
 * The tour, in order.
 *
 * Each step is `{ id, say, hint, at, done, arm }`:
 *
 * - `say`   the sentence in the card. One instruction. If it needs two, it is
 *           two steps — every attempt to save a step here has produced a card
 *           somebody read half of.
 * - `hint`  the small print under it: what the gesture actually is.
 * - `at`    where the hole goes. `{ el }` names a selector in the HUD, `{ world }`
 *           names a point in the shop and lights the canvas whole, and nothing
 *           at all means a card in the middle with no veil, which is what the
 *           first and last beats want.
 * - `done`  the predicate. Asked every snapshot and never anything else.
 * - `arm`   run once when the step opens, for the two occasions where the tour
 *           has to put a menu in front of you rather than ask you to find it.
 *
 * `hold` marks the steps that are waiting on the *world* rather than on you —
 * the van, mostly — so the card can say so instead of reading as an instruction
 * you are failing to follow.
 */
/**
 * The tour, in order. TEN beats, and the count is the design.
 *
 * It was eighteen, one card per press, and eighteen cards is a lecture — you
 * stop reading at about the fifth and start hunting for Skip. The saving is not
 * in cutting what it teaches: it teaches the same ten things. It is that a step
 * **moves its own spotlight**. `at` and `say` are asked every frame, so "open the
 * crew strip, then press the Shop Hand on it" is one card whose hole walks from the
 * rail button to the tile the moment the strip is up — which is what the player
 * was going to do anyway, with one fewer thing to read on the way.
 *
 * That is the rule for adding a beat: a card per *decision*, never a card per
 * press. Two presses that have one outcome between them are one card.
 *
 * Each step is `{ id, kicker, say, hint, at, done, arm, nudge, waiting }`:
 *
 * - `say`     the instruction, and a function when it changes mid-step.
 * - `hint`    the small print. It has to name the ACTUAL thing — "and then it
 *             does the obvious thing" is the sentence this whole file exists
 *             because nothing in this game is obvious.
 * - `at`      where the hole goes, asked every frame. `{ el }` names something
 *             in the HUD, `{ world }` names a thing standing in the shop and
 *             lights the canvas whole, `null` inside either means "cannot find
 *             it" and drops the veil entirely (see `holeFor`).
 * - `done`    the predicate, over the snapshot. Never a press.
 * - `arm`     once, on open. For putting a menu in front of you.
 * - `nudge`   every snapshot. For keeping it there, and for the one-way latches
 *             a two-phase step needs (`crate`, below).
 * - `waiting` the step cannot be finished yet and that is nobody's fault — the
 *             van. The card breathes and the stranded-timer is held off, or a
 *             wait reads as an instruction you are failing to follow.
 */
const STEPS = [
  {
    id: 'hello',
    kicker: 'New shop',
    say: 'Morning. I fit shops out — give me a minute.',
    hint: 'Stock on the shelves, somebody on the till, doors open. Skip is '
      + 'bottom right, on every card.',
    big: true,
  },

  {
    id: 'walk',
    kicker: 'Getting about',
    say: (t) => perInput(
      t.step?.spot ? 'Click the marked tile. You walk to it.' : 'Click a bit of floor. You walk to it.',
      t.step?.spot ? 'Tap the marked tile. You walk to it.' : 'Tap a bit of floor. You walk to it.',
    ),
    // Both halves of the mouse, because a press that MOVED is never a walk —
    // and the camera is the thing a new player reaches for first and finds by
    // accident. Either button drags the view; which one decides whether it
    // slides or swings.
    //
    // The finger's half is the same fact in the other grammar, and it has to be
    // said at least as plainly: a drag is the camera there too, so the first
    // thing anybody does by accident is slide the shop rather than walk. Two
    // fingers is the whole of the rest of it — pinch and twist — and there is no
    // wheel and no WASD to fall back on.
    hint: () => perInput(
      'Hold a mouse button and drag to move the camera — left or right, '
        + 'same thing. Wheel zooms. WASD walks you without clicking.',
      'Drag with one finger to move the camera. Two fingers pinch to zoom and '
        + 'twist to swing it round.',
    ),
    // Ringed on the floor rather than "somewhere over there". The tile is
    // chosen once and held, or the mark walks away from you as you approach it.
    at(t) {
      this.spot ??= spotToWalk(t);
      return { world: this.spot, y: 0.04 };
    },
    start(t) { this.spot = spotToWalk(t); },
    // Arriving OR simply having gone a fair way. The ringed tile is the
    // instruction, not the test: somebody who clicks two tiles to its left has
    // done the thing this card teaches, and a card that then still wanted that
    // exact square would be a tutorial arguing with a player who understood it.
    done(t) {
      const me = meOf(t);
      if (!me) return false;
      this.from ??= { ...me };
      return (this.spot && dist(me, this.spot) < 1.6) || dist(me, this.from) > 2.5;
    },
  },

  {
    id: 'stock',
    kicker: 'Buying in',
    // `inSupplier` rather than the id, because one press into an item is still
    // being in the supplier — see `client/item-menu.js`. Asked of the id alone,
    // opening a row to look at what it costs swaps the copy back to "open the
    // supplier" and points the veil at a rail button, over a panel that IS the
    // supplier. You can order from in there too, which is the same `done`.
    say: (t) => (inSupplier(t)
      ? 'Buy a case of something cheap.'
      : 'Nothing to sell yet. Open the supplier.'),
    hint: (t) => (inSupplier(t)
      ? 'It comes on the van to the pad behind the shop. You carry it in from '
        + 'there, until you hire a stocker to do it.'
      : 'Stock comes from three places: bought in here, grown in the beds out '
        + 'the side, or made on a machine.'),
    // The hole is the whole panel, because choosing WHAT to buy is the half of
    // this step that is yours — but a lit panel cannot say which press ends it,
    // and forty rows of `×6` is exactly the list where that matters. So the
    // first row that can actually be bought gets the small mark: `.owned` is
    // what a row wears when it is dimmed for having nowhere to go or costing
    // more than the till holds, and pulsing one of those is teaching a press
    // the shop refuses. The drill-down's own `×6` is in the same selector,
    // since one press into an item is still being in the supplier.
    at: (t) => (inSupplier(t)
      ? {
        el: '#panel',
        pulse: '#panel .sec-row:not(.owned) [data-btn-tag="buy"], #panel [data-act="buy"]',
      }
      : { el: '[data-rail="stock"]' }),
    done(t) { return (t.state?.orders?.pending ?? []).length > 0 || t.crateSeen; },
  },

  {
    id: 'hire',
    kicker: 'The crew',
    /**
     * MEET THE ONE YOU ALREADY HAVE.
     *
     * This beat used to buy somebody: "take on a Shop Hand", ending on
     * `roster.length > 0`. A new shop comes with one now (`starterHire` in
     * server/worlds.js), so that predicate is true on the frame the card opens
     * — the beat completed instantly, and what you saw was a card that flashed
     * past on its way to the next one.
     *
     * Asking for a SECOND hire is the obvious repair and it is the wrong one:
     * it spends $200 of a $250 float on a shop with two shelves and nothing on
     * them, which is the tour teaching somebody to go broke. And the lesson was
     * never the purchase — it is that the crew exist, that they are leased
     * machines, and that the strip along the bottom is where they live. All of
     * that is still there to be shown, and now there is somebody standing in it
     * to be shown WITH.
     *
     * So it opens their tile instead, which is a press you can make with no
     * money at all, and `done` is the panel being up rather than the roster
     * having grown.
     */
    say: (t) => (t.ui.bar === 'staff'
      ? perInput('Click their tile to open them up.', 'Tap their tile to open them up.')
      : 'Somebody already works here. Open the crew strip.'),
    hint: (t) => (t.ui.bar === 'staff'
      ? 'The shop came with a hand. They serve, they fill shelves, they work '
        + 'the beds — and the lease comes off the takings every morning.'
      : 'Everyone here is a machine you lease. This is where you take on more '
        + 'of them, and where you look at the ones you have.'),
    at: (t) => {
      if (t.ui.bar !== 'staff') return { el: '[data-rail="staff"]' };
      const who = (t.state?.roster ?? [])[0];
      return { el: who ? `[data-entry="hire:${who.id}"]` : null, pad: 6 };
    },
    arm(t) { t.ui.closePanel?.(); },
    // The strip files who works here under one tab per kind and who you could
    // take on under `hire`, so the tile is only in the document while the right
    // tab is open. `all` rather than `hire` now: the tile being pointed at is
    // somebody who already works here.
    nudge(t) {
      if (t.ui.bar !== 'staff' || t.ui.barTab.staff === 'all') return;
      t.ui.barTab.staff = 'all';
      t.ui.renderHotbar();
    },
    done(t) { return t.ui.openPanel === 'worker'; },
  },

  {
    id: 'shift',
    kicker: 'The crew',
    say: (t) => {
      if (t.ui.openPanel === 'worker') return 'Move a point around. Take one off a job they will not be doing.';
      if (t.ui.bar !== 'staff') return 'Open the crew strip again — the robot icon.';
      return perInput('Open them up — click their tile on the strip.',
        'Open them up — tap their tile on the strip.');
    },
    hint: (t) => (t.ui.openPanel === 'worker'
      ? 'Each number is a share of their day. The total is capped, so adding to '
        + 'one takes from another. A greyed-out + means that job is already full.'
      : 'You choose what they spend the day on: the till, putting stock out, '
        + 'sweeping up, the beds.'),
    // The whole list, never the Serve `+`. That button goes dead the moment the
    // shift is full — which on a fresh clerk it usually already is — so a hole
    // cut round it is a hole round a button that cannot be pressed, with the
    // `−` that would make room for it out in the blackout. The lesson was never
    // "press +", it is "these numbers come out of one another".
    at: (t) => {
      if (t.ui.openPanel === 'worker') return { el: '.wk-jobs', pad: 8 };
      if (t.ui.bar !== 'staff') return { el: '[data-rail="staff"]' };
      const who = (t.state?.roster ?? [])[0];
      return { el: who ? `[data-entry="hire:${who.id}"]` : null, pad: 6 };
    },
    arm(t) { t.ui.showBar('staff'); t.ui.barTab.staff = 'all'; t.ui.renderHotbar(); },
    // Self-healing rather than armed-once: close the sheet and the hole walks
    // back to the tile, which only exists while the strip is up.
    // Only the tab, never the bar — see the freezer step's `nudge`. A strip you
    // closed staying closed is the difference between a tutorial and a fight.
    nudge(t) {
      if (t.ui.bar !== 'staff' || t.ui.barTab.staff === 'all') return;
      t.ui.barTab.staff = 'all';
      t.ui.renderHotbar();
    },
    start(t) { this.from = t.jobSig(); },
    done(t) { return this.from !== null && t.jobSig() !== this.from; },
  },

  {
    id: 'freezer',
    kicker: 'Building',
    say: (t) => {
      if (t.ui.bar !== 'build') return 'Open build mode again — it is the hammer.';
      const p = cheapestFreezer(t);
      if (t.ui.toolId?.() !== p?.id) return `Pick the ${p?.name ?? 'chiller'} out of the Shop tab.`;
      return perInput('Click a bit of floor to stand it there.',
        'Tap a bit of floor to stand it there. Press and hold instead and you '
          + 'can slide it about before you let go.');
    },
    hint: (t) => {
      const p = cheapestFreezer(t);
      if (t.ui.toolId?.() !== p?.id) {
        return `${p ? `${money(p.cost)}. ` : ''}Frozen goods rot on a normal shelf `
          + 'and keep in here. I opened the catalogue for you — normally that is '
          + 'the Build button, pressed twice.';
      }
      // Turning it is the half you need BEFORE you put it down, so it goes
      // first — a facing you fix afterwards is a fixture you have already paid
      // to stand in the wrong direction. The wheel stops zooming while
      // something is armed, which is worth saying outright: a control that
      // quietly changes job is one you find by accident or never.
      //
      // A finger has neither control, so on a phone the honest instruction is
      // the other order: stand it down, then turn it from its own menu. Saying
      // "R turns it" to somebody with no keyboard is the whole failure this
      // helper exists for — and the shop turns it to face a wall by itself
      // (`faceAlong`), which is what makes the later fix a fix rather than a
      // chore.
      return perInput(
        'R turns it before you place it, and so does the wheel — while '
          + 'something is armed the wheel turns instead of zooming. Green means it '
          + 'fits. Amber means it fits but will block something, and the shop lets '
          + 'you do it anyway.',
        'It turns its back to a wall on its own. The round button by the bar '
          + 'turns it a quarter at a time before you place it. Green means it '
          + 'fits. Amber means it fits but will block something, and the shop '
          + 'lets you do it anyway.',
      );
    },
    at: (t) => {
      if (t.ui.bar !== 'build') return { el: '[data-rail="build"]' };
      const p = cheapestFreezer(t);
      if (t.ui.toolId?.() !== p?.id) return { el: p ? `[data-entry="${p.id}"]` : null, pad: 6 };
      return { el: '#game', soft: true };
    },
    /**
     * Both presses, for them.
     *
     * Build is the one rail button that does something different the second
     * time — the first press is the mode, the second brings the catalogue up —
     * and that is a fact about the BAR, which is at the bottom of the screen
     * behind the card. So a step that asked for a press got one, changed
     * nothing anybody could see, and sat there asking again. Pressed twice
     * here, through `pressBuild` itself rather than by setting the two flags,
     * so the mode is entered exactly the way a player enters it. The two-press
     * rule is in the hint, which is where a thing you need once belongs.
     */
    arm(t) {
      t.ui.closePanel?.();
      t.ui.pressBuild();
      if (t.ui.bar !== 'build') t.ui.pressBuild();
    },
    /**
     * It picks the TAB and never the mode.
     *
     * This used to re-press Build whenever the bar was down, every snapshot —
     * so leaving build mode yourself put you straight back in it, ten times a
     * second, with nothing having been pressed. And build mode swaps the camera
     * off your body onto the map (`setFreeRoam`), so what it presented as was
     * the pan and tilt jamming for no reason: a mode you did not choose holding
     * a camera you did not move.
     *
     * A nudge may keep a menu tidy. It may not re-take a decision the player has
     * just made — `at` points back at the Build button instead, which is the
     * same thing said out loud.
     */
    nudge(t) {
      if (t.ui.bar !== 'build') return;
      if (t.ui.barTab.build === 'shop') return;
      if (t.ui.toolId?.() === cheapestFreezer(t)?.id) return;
      t.ui.selectBuildGroup?.('shop');
    },
    start(t) { this.from = shelvesOf(t, 'freezer').length; },
    done(t) { return this.from !== null && shelvesOf(t, 'freezer').length > this.from; },
  },

  {
    id: 'take-one',
    kicker: 'Stock',
    /**
     * Three sentences, because there are three situations and only one of them
     * is an instruction you can act on.
     *
     * It used to be one card carrying all of it — walk over, then click, and by
     * the way here are four presses — read at the moment you are stood across
     * the shop with nothing to do but walk. Half of it was about a thing you
     * could not do yet, which is how a card gets skimmed. So the walk is its
     * own sentence, and the rest arrives when you get there.
     */
    /**
     * ...and what a walk to a crate ENDS IN is the lift, which this card spent
     * its life not saying.
     *
     * `errandAction` is explicit about it — "empty-handed at a crate is a LIFT,
     * and full hands is the armful it always was" — so tapping a box you are not
     * stood at walks you over and shoulders the whole thing about half a second
     * after you arrive, before there is anything to press. The card's second
     * sentence ("now take one unit out") describes a state you can only reach by
     * NOT doing what its first sentence told you to.
     *
     * What that reads as is the tour not noticing you moved: the box goes on
     * your shoulder, it leaves `deliveries`, `nearestCrate` re-points at the
     * next one on the pad, and the same "tap the crate, you will walk over to
     * it" comes back — over a shop where you are visibly carrying a crate.
     *
     * So the walk is told what it ends in, the arrival is a separate sentence
     * again for somebody who was already standing there, and `done` accepts
     * either way of getting goods off the pad. The step is "you got the stock
     * out of the yard", and the shop has two ways to do that.
     *
     * Nothing in here says anything ABOUT holding the box, deliberately: `done`
     * takes the same frame, so a card for it would be a sentence nobody can
     * read. What it is for is said one beat later, on the shelf it goes on.
     */
    say: (t) => {
      const c = nearestCrate(t);
      if (!c) return 'Van is on its way. Crates get left on the pad round the back.';
      if (!atIt(t, c)) {
        return perInput('Click the crate. You walk over and pick the whole box up.',
          'Tap the crate. You walk over and pick the whole box up.');
      }
      // The second half is where the two grammars stop being the same sentence
      // with a different verb in it. A press names a thing on a phone and never
      // does anything to it, so "tap it again" is not a clumsy way of saying
      // this — it is wrong, and following it does nothing at all.
      return perInput('Now click it again to take one unit out.',
        'Now press Take one, on the bar along the bottom.');
    },
    // The four presses, said once, in the one place the player is holding the
    // mouse over the thing they are about. This is the sentence the whole tour
    // exists to deliver — everything else is scaffolding round it.
    // The walk is part of the press, and saying so is the whole point of this
    // line: one click books the job, and the unit does not move until you are
    // stood at it. Without that, the walk reads as the click having missed —
    // so you click again, which re-books the same job and looks just as dead.
    hint: (t) => {
      const c = nearestCrate(t);
      if (!c) return 'Somebody has to carry it in off the pad. Today that is you.';
      if (!atIt(t, c)) {
        return perInput(
          'Clicking something you are not stood at walks you there and then does '
            + 'the job. Standing at it already, a click takes one unit instead.',
          'Tapping something you are not stood at walks you there and then does '
            + 'the job. Standing at it already, the bar offers one unit instead.',
        );
      }
      return perInput(
        'Left click picks up one. Press and hold to pick up the whole box. '
          + 'Right click is for dropping off instead. Same on every crate, shelf '
          + 'and machine in the shop.',
        'That bar lists everything this thing can do. A press does the top one; '
          + 'the rows marked HOLD want holding down — that is how you shoulder '
          + 'the whole box. Same for every crate, shelf and machine in the shop.',
      );
    },
    arm(t) { t.ui.toggleBuild?.(false, { quiet: true }); t.ui.showBar(null); },
    at: (t) => ({ world: nearestCrate(t), y: CRATE_Y }),
    // Nobody's fault and nothing to press. Without this the card reads as an
    // instruction you are failing, and the stranded-timer offers to skip the
    // one beat the whole tour is building up to.
    // ...and a box on your shoulder is not waiting for a van, however empty the
    // pad is: the step is finished either way and the next frame says so.
    waiting(t) { return !nearestCrate(t) && !meOf(t)?.haul; },
    done(t) { const m = meOf(t); return lotSize(m?.carry) > 0 || !!m?.haul; },
  },

  {
    id: 'shelve-one',
    kicker: 'Stock',
    /**
     * ...and which of the two you are holding, because the beat before this one
     * can hand you either.
     *
     * Written for an armful alone, a box broke this twice over: the words named
     * a row a shoulder is never offered (`Put one on`), and `done` was "your
     * hands are empty" — which is true of somebody carrying a crate on the frame
     * they arrive, so the step completed the instant it opened and the tour
     * skipped the one lesson it exists to teach. Both halves ask the shop's own
     * question, which is `p.haul`.
     */
    say: (t) => (meOf(t)?.haul
      ? perInput('HOLD the RIGHT button on a shelf to tip the box in.',
        'Tap a shelf, then HOLD Stock it to tip the box in.')
      : perInput('RIGHT-click a shelf to put the unit on it.',
        'Tap a shelf, then press Put one on.')),
    // The direction is the lesson on a mouse and there is no direction on a
    // phone: one button, and which way the goods go is whichever row you press.
    // So the finger's version teaches the row instead — same fact, and the
    // chevrons are worth naming in both, since they are the only thing on screen
    // that answers "which shelf will take this".
    hint: () => perInput(
      'Left picks up, right drops off. Hold right to drop off everything at '
        + 'once. Arrows point at every shelf that will take what you are holding.',
      'Put one on is one unit; hold Stock it to pour in everything that fits. '
        + 'Arrows point at every shelf that will take what you are holding.',
    ),
    at: (t) => ({ world: anyShelf(t), y: SHELF_Y }),
    // Both stores, because the goods can be in either and the step is "you put
    // them somewhere". A pour that does not empty the box leaves the rest on
    // your shoulder — which is the honest answer to a shelf that filled up, and
    // the next shelf is the next tap.
    done(t) { const m = meOf(t); return !m?.haul && lotSize(m?.carry) === 0; },
  },

  {
    id: 'crate',
    kicker: 'Stock',
    say: (t) => (meOf(t)?.haul
      ? perInput('Now HOLD the RIGHT button on a shelf to tip the box in.',
        'Now tap a shelf and HOLD Stock it to tip the box in.')
      : perInput('One at a time is a long afternoon. Stand at the crate and HOLD the left button.',
        'One at a time is a long afternoon. At the crate, HOLD Pick the crate up.')),
    hint: (t) => (meOf(t)?.haul
      ? perInput(
        'Right drops off, and holding drops off the lot. It stops when the shelf '
          + 'is full; the rest stays on your shoulder.',
        'It stops when the shelf is full; the rest stays on your shoulder.',
      )
      : perInput(
        'Hold it down and a ring winds round. Let go early and nothing happens. '
          + 'A box carries far more than your arms do.',
        'Keep it held and the row fills up. Let go early and nothing happens. '
          + 'A box carries far more than your arms do.',
      )),
    at: (t) => (meOf(t)?.haul
      ? { world: anyShelf(t), y: SHELF_Y }
      : { world: nearestCrate(t), y: CRATE_Y }),
    // A latch, because the step is two halves and the second half's predicate
    // (`no box on your shoulder`) is also true of somebody who never lifted one.
    start() { this.lifted = false; },
    nudge(t) { if (meOf(t)?.haul) this.lifted = true; },
    done(t) { return this.lifted && !meOf(t)?.haul; },
    // No box left to lift is not a failure — you may well have shelved the lot
    // by hand on the beat before.
    skipWhen(t) { return !nearestCrate(t) && !meOf(t)?.haul; },
  },

  {
    id: 'menu',
    kicker: 'Shelves',
    say: 'Press and hold on that shelf to open its menu.',
    // A hold is the other half of every press in the game and nothing on screen
    // says so. It is the only way to reach what a thing can DO, and a player
    // who never finds it never prices anything, never sets a shelf aside and
    // never sells a fixture back.
    hint: () => perInput(
      'A click uses a thing. Holding the button opens what it can do. That '
        + 'is true of every shelf, crate, machine and doorway in the shop.',
      'A tap picks a thing out and lists what it can do along the bottom. '
        + 'Holding opens the whole menu — every shelf, crate, machine and '
        + 'doorway in the shop has one.',
    ),
    at: (t) => ({ world: anyShelf(t), y: SHELF_Y }),
    done(t) { return t.ui.openPanel === 'fixture'; },
  },

  {
    id: 'assign',
    kicker: 'Shelves',
    // "Quick pick" and not "Keep it for", which is the heading this card named
    // for as long as that heading was on screen. It still exists — it is the
    // second group in the shelf's menu — but a fixture menu's tabs are icons on
    // purpose (see `ui.js`, where the argument is made: those headings are
    // sentences, so they are captions rather than tabs), so the only one whose
    // words are ever rendered is whichever tab is open. That is the shortlist,
    // every time: `group` drops an empty group and Quick pick is built first.
    //
    // So the old copy sent you hunting a quoted label that appears nowhere in
    // the panel, which is the worst shape an instruction can have — it reads as
    // the menu being wrong rather than the sentence being old. The rows are the
    // same rows either way (`quickRows` is a *selection* of the full list, not a
    // second list about the same items), so the press this card is asking for is
    // unchanged and so is `done`.
    say: (t) => (t.ui.openPanel === 'fixture'
      ? 'Under "Quick pick", choose what this shelf is for.'
      : 'Press and hold the shelf again to bring its menu back.'),
    hint: (t) => (t.ui.openPanel === 'fixture'
      ? 'Now your crew will restock it with that and nothing else, and the shop '
        + 'will order more when it runs low. The same menu sets the price per '
        + 'board, hides the shelf out the back, tells the crew to leave it '
        + 'alone, and upgrades, moves or sells the unit.'
      : perInput('You clicked off it, which closes the menu. Nothing was lost.',
        'You tapped off it, which closes the menu. Nothing was lost.')),
    // Two phases, because the menu is a thing the player can shut — clicking on
    // the world is how you dismiss ANY panel, so a step that only ever pointed
    // at `#panel` had nothing to point at the moment somebody clicked the floor,
    // and sat there stranded on a card asking about a menu that was not up.
    //
    // It asks for the menu back rather than re-opening it: the click that shut
    // it was deliberate, and a panel that springs back up under you is a
    // tutorial wrestling you for the mouse.
    at: (t) => (t.ui.openPanel === 'fixture'
      ? { el: '#panel' }
      : { world: anyShelf(t), y: SHELF_Y }),
    start(t) { this.from = keptCount(t); },
    done(t) { return this.from !== null && keptCount(t) > this.from; },
  },

  {
    id: 'open',
    kicker: 'Opening up',
    say: () => perInput('Last thing. Click the sign to raise the shutters.',
      'Last thing. Tap the sign to raise the shutters.'),
    hint: 'A new shop starts shut so you can set it up in peace. Open it and the '
      + 'town starts turning up. Good luck.',
    at: () => ({ el: '#sign', pad: 8 }),
    done(t) { return t.state?.shutters === true; },
    /**
     * ...and the one question the tour is uniquely placed to ask.
     *
     * A new shop's build bar unfolds as it grows (`shared/reveal.js`) — a few
     * buttons at the start, conveyors once there have been five hundred sales.
     * That is right for the person the tutorial is for and wrong for the person
     * who has played before, and until now the only way to say so was to find it
     * in the Menu, which is precisely what somebody on their first shop does not
     * know to do.
     *
     * **Here rather than as a card of its own**: a card whose whole content is a
     * setting ends the tour on admin rather than on opening the shop, and this
     * is a question most people should answer by ignoring it.
     *
     * **And it is a SENTENCE, not a labelled button.** It shipped as one reading
     * "Show all build tools", and the words were the whole problem: somebody who
     * has been playing for four minutes does not know what a build tool is, has
     * never seen the palette hold anything back, and cannot tell a button that
     * turns something ON from one that turns a limit OFF. A press with no
     * question attached is not a choice, it is a dare. So the words do the
     * asking — what is happening, why, and the answer as a link inside them —
     * and what it leaves behind says where to change your mind, because a
     * setting you cannot find again is one nobody should touch on their first
     * day.
     *
     * `when` is the half that keeps it honest: a shop that already has the whole
     * bar is never asked, so this is never a no-op wearing a choice — and it is
     * where somebody who turned it off in the Menu five minutes ago would
     * otherwise be asked to turn it off again.
     */
    offer: {
      ask: 'One last thing: the build menu only shows a few things to start '
        + 'with, and unlocks the rest as the shop grows. If you have played '
        + 'games like this before, you can have the whole lot now —',
      label: 'unlock everything',
      took: 'Done — every build tool is yours from the off. Menu › Ease me in '
        + 'changes it back whenever you like.',
      when: (t) => t.ui?.state?.reveal === true,
      run: (t) => t.ui?.setReveal?.(false),
    },
  },
];

/**
 * ...AND THE SAME SHOP FROM THE OTHER SIDE OF THE DOOR.
 *
 * A guest arrives into a shop that is already furnished, already stocked, and
 * already somebody else's — so two thirds of the tour above is not mis-phrased
 * for them, it is about decisions that are not theirs to make on the first
 * minute. Nothing STOPS them: the room gates nothing, a guest is a second
 * shopkeeper with the same powers and the same drawer, which is what the cards
 * say. But a tour that opened with "buy a case of something cheap" would be
 * teaching a visitor to spend their friend's takings before they can walk, and
 * the shutters are somebody else's decision about their own trade.
 *
 * What is left is the half that is about a pair of hands rather than about a
 * shop, and it is exactly the half nothing in the game explains: a tap names,
 * the left button takes, the right button puts, a hold does the lot, and a hold
 * on a fixture opens what it can do. Five beats, no money, nothing that changes
 * what the shop IS.
 *
 * **Every predicate here is a delta and never a level**, which is the trap this
 * list is written around. `done(t) { return shelvesOf(t).length }` is a fine
 * question in a shop you have just made and a *tautology* in one that has been
 * trading for a hundred days: the tour would run its whole length in the first
 * frame, ten cards flashing past, ending on a toast about a tutorial nobody
 * saw. So each beat records what was true when it opened (`start`) and asks
 * what has changed since — and the two that are about your hands latch what
 * they have seen, because "holding nothing" is both the state before you pick
 * anything up and the state after you have put it down.
 */
const GUEST_STEPS = [
  {
    id: 'g-hello',
    kicker: 'Somebody else\'s shop',
    say: 'You are in. Same shop, same till — you are the second shopkeeper.',
    hint: 'Everything is shared, money included: you can order stock, take '
      + 'somebody on and build, and it all comes out of the same drawer. This '
      + 'shows you the hands-on half. Skip is bottom right, on every card.',
    big: true,
  },

  {
    id: 'g-walk',
    kicker: 'Getting about',
    say: (t) => perInput(
      t.step?.spot ? 'Click the marked tile. You walk to it.' : 'Click a bit of floor. You walk to it.',
      t.step?.spot ? 'Tap the marked tile. You walk to it.' : 'Tap a bit of floor. You walk to it.',
    ),
    hint: () => perInput(
      'Hold a mouse button and drag to move the camera — left or right, '
        + 'same thing. Wheel zooms. WASD walks you without clicking.',
      'Drag with one finger to move the camera. Two fingers pinch to zoom and '
        + 'twist to swing it round.',
    ),
    at(t) {
      this.spot ??= spotToWalk(t);
      return { world: this.spot, y: 0.04 };
    },
    start(t) { this.spot = spotToWalk(t); },
    done(t) {
      const me = meOf(t);
      if (!me) return false;
      this.from ??= { ...me };
      return (this.spot && dist(me, this.spot) < 1.6) || dist(me, this.from) > 2.5;
    },
  },

  {
    id: 'g-take',
    kicker: 'Stock',
    /**
     * A crate if there is one on the pad, else a shelf — and it has to be both,
     * because which of them a guest arrives to is a fact about somebody else's
     * afternoon. The host's tour can rely on a van having been sent, since it
     * sent it a beat ago; this one relies on nothing.
     */
    // ...and a walk to a CRATE ends in the lift, which is the same thing the
    // host's `take-one` says at length: `errandAction` shoulders a box for
    // somebody who arrives empty-handed, so promising one unit is promising the
    // one outcome that press cannot have. A shelf is untouched — arriving at one
    // arms nothing until you press, so there the old sentence is exactly true.
    say: (t) => {
      const c = nearestCrate(t);
      const target = c ?? anyShelf(t);
      if (!target) return 'Nothing to hand just now. Skip on, or wait for the van.';
      if (!atIt(t, target)) {
        return perInput(
          c ? 'Click the crate. You walk over and pick the whole box up.'
            : 'Click the shelf. You will walk over to it.',
          c ? 'Tap the crate. You walk over and pick the whole box up.'
            : 'Tap the shelf. You will walk over to it.',
        );
      }
      return perInput('Now click it again to take one unit out.',
        'Now press Take one, on the bar along the bottom.');
    },
    hint: () => perInput(
      'Left click picks up one. Press and hold to pick up the whole box. '
        + 'Right click is for dropping off instead. Same on every crate, shelf '
        + 'and machine in the shop.',
      'That bar lists everything this thing can do. A press does the top one; '
        + 'the rows marked HOLD want holding down. Same for every crate, shelf '
        + 'and machine in the shop.',
    ),
    at: (t) => {
      const c = nearestCrate(t);
      return c ? { world: c, y: CRATE_Y } : { world: anyShelf(t), y: SHELF_Y };
    },
    // Full hands on arrival are a real state — `Game.away` gives a returning
    // guest back what they were holding — so this is what CHANGED rather than
    // what is true. Without it, rejoining mid-armful skips the beat that the
    // next one is written to follow.
    start(t) { this.had = lotSize(meOf(t)?.carry); },
    // ...or the box, which is what a walk to a crate actually leaves you with.
    done(t) { const m = meOf(t); return lotSize(m?.carry) > (this.had ?? 0) || !!m?.haul; },
    waiting(t) { return !nearestCrate(t) && !anyShelf(t) && !meOf(t)?.haul; },
  },

  {
    id: 'g-shelve',
    kicker: 'Stock',
    // The same pair of sentences the host's `shelve-one` carries, and for the
    // same reason: `g-take` can now leave you with a box, and a shoulder is
    // never offered `Put one on`.
    say: (t) => (meOf(t)?.haul
      ? perInput('HOLD the RIGHT button on a shelf to tip the box in.',
        'Tap a shelf, then HOLD Stock it to tip the box in.')
      : perInput('RIGHT-click a shelf to put the unit on it.',
        'Tap a shelf, then press Put one on.')),
    hint: () => perInput(
      'Left picks up, right drops off. Hold right to drop off everything at '
        + 'once. Arrows point at every shelf that will take what you are holding.',
      'Put one on is one unit; hold Stock it to pour in everything that fits. '
        + 'Arrows point at every shelf that will take what you are holding.',
    ),
    at: (t) => ({ world: anyShelf(t), y: SHELF_Y }),
    // The latch the `crate` beat needs for the same reason: empty hands are
    // where this started as well as where it ends, so the beat has to have SEEN
    // them full. `g-take` leaves them that way, and a guest who put the lot down
    // some other way has still done the thing.
    // ...and the latch watches both stores now, or a guest who walked over and
    // shouldered the box never sets it and the beat never ends.
    start() { this.held = false; },
    nudge(t) { const m = meOf(t); if (lotSize(m?.carry) > 0 || m?.haul) this.held = true; },
    done(t) { const m = meOf(t); return this.held && !m?.haul && lotSize(m?.carry) === 0; },
  },

  {
    id: 'g-menu',
    kicker: 'Shelves',
    say: 'Press and hold on a shelf to open its menu.',
    hint: () => perInput(
      'A click uses a thing. Holding the button opens what it can do — the '
        + 'price, what it is kept for, what is on it. Every shelf, crate, '
        + 'machine and doorway in the shop has one.',
      'A tap picks a thing out and lists what it can do along the bottom. '
        + 'Holding opens the whole menu — the price, what it is kept for, what '
        + 'is on it. Every shelf, crate, machine and doorway has one.',
    ),
    at: (t) => ({ world: anyShelf(t), y: SHELF_Y }),
    done(t) { return t.ui.openPanel === 'fixture'; },
  },

  {
    id: 'g-off',
    kicker: 'That is the lot',
    say: 'That is the hands. The rest of the shop works the same for you.',
    hint: 'Crew, prices, ordering and building are all open to you — worth a '
      + 'word with whoever invited you before you spend the takings. If they '
      + 'leave, the shop goes with them, and whatever you were holding comes '
      + 'back to you next time you join.',
    big: true,
  },
];

// ---------------------------------------------------------------------------
// The robot
// ---------------------------------------------------------------------------

/**
 * The face, as one inline SVG.
 *
 * Drawn here rather than taken from `artForWorker` on purpose: every hire in the
 * game is a body somebody authored into the content database, and a tutor built
 * out of one would disappear the day that row was deleted — on the screen whose
 * whole job is being there for somebody who has never seen the game. It is also
 * the one character in the shop who is not IN the shop.
 *
 * The eyes are two rects with a CSS animation on their height, so it blinks
 * without a frame loop and without anything to clean up.
 */
const FACE = `
  <svg class="tt-face" viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="ttbody" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#f4efe4"/><stop offset="1" stop-color="#d8cfbe"/>
      </linearGradient>
    </defs>
    <path class="tt-ant" d="M32 12 V5" stroke-width="3" stroke-linecap="round"/>
    <circle class="tt-bulb" cx="32" cy="4" r="3.4"/>
    <rect x="9" y="12" width="46" height="40" rx="13" fill="url(#ttbody)"
      stroke="rgba(58,49,40,.28)" stroke-width="2"/>
    <rect x="15" y="20" width="34" height="21" rx="8" fill="#2f3b46"/>
    <rect class="tt-eye" x="22" y="26" width="6" height="9" rx="3"/>
    <rect class="tt-eye tt-eye2" x="36" y="26" width="6" height="9" rx="3"/>
    <path class="tt-smile" d="M25 45 q7 4 14 0" fill="none" stroke-width="2.6"
      stroke-linecap="round"/>
    <rect x="2" y="27" width="6" height="13" rx="3" fill="#cfc5b2"/>
    <rect x="56" y="27" width="6" height="13" rx="3" fill="#cfc5b2"/>
  </svg>`;

// ---------------------------------------------------------------------------

export class Tutor {
  constructor(ui, net, scene, el) {
    this.ui = ui;
    this.net = net;
    this.scene = scene;
    this.el = el;
    this.state = null;
    this.i = -1;
    this.step = null;
    // Whether the step's own press has been taken this run. On the tour rather
    // than on the step, because a step object is a module-level literal shared
    // by every tour this page ever runs — a flag stored there would make Replay
    // open the last card with the offer already spent.
    this.offerTaken = false;
    // WHICH tour. The host's by default, and swapped whole rather than filtered:
    // a guest's beats are not the owner's with the money ones taken out, they
    // are phrased for a shop that is somebody else's and already trading.
    this.steps = STEPS;
    // ...and which mark finishing it writes. A world for the owner, a person for
    // the guest — see `GUEST_KEY`.
    this.guest = false;
    this.on = false;
    this.camMoved = false;
    this.crateSeen = false;
    this.render();

    // The camera step's predicate. It is the one thing in the tour that is not a
    // fact about the shop — nothing the server is told changes when you swing
    // the view — so it is the one place a step watches an input. Capture phase
    // and passive, so it can never eat a press the game wanted.
    const moved = (e) => {
      if (!this.on) return;
      if (e.type === 'wheel' || e.buttons === 2 || e.button === 2) this.camMoved = true;
      if (e.type === 'keydown' && [',', '.'].includes(e.key)) this.camMoved = true;
    };
    for (const ev of ['wheel', 'pointermove', 'keydown']) {
      addEventListener(ev, moved, { capture: true, passive: true });
    }

    // Esc leaves, exactly as it backs out of everything else. It has to be
    // capture, or the game's own Esc handler closes a menu the veil is pointing
    // at and leaves the card asking for it.
    addEventListener('keydown', (e) => {
      if (!this.on || e.key !== 'Escape') return;
      e.stopPropagation();
      this.quit('skipped');
    }, { capture: true });

    addEventListener('resize', () => this.place());
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Should this shop get the tour?
   *
   * Three questions, and they are asked in this order because they answer
   * different people: the switch is the person, the `done` mark is this shop,
   * and `new` is what makes it a shop rather than a save somebody is halfway
   * through. Nothing here looks at `day` — see `markWorldNew`.
   */
  maybeStart(worldId) {
    this.world = worldId ?? null;
    this.steps = STEPS;
    this.guest = false;
    if (!this.world || tutorOff()) return;
    if (listOf(DONE_KEY).includes(this.world)) return;
    if (!listOf(NEW_KEY).includes(this.world)) return;
    this.start();
  }

  /**
   * The other door in: somebody who joined a shop rather than making one.
   *
   * Its own entry point and not a flag on `maybeStart`, because the three
   * questions that one asks are all about a *world* — is this shop new, has this
   * shop been toured — and a guest has no world id at all (`openAsGuest` puts
   * nothing in the address bar, on purpose: the shop is not theirs). The only
   * question here is whether this person has ever been shown the gestures.
   *
   * The switch still wins. A guest who turned tutorials off is somebody who
   * turned tutorials off.
   */
  guestStart() {
    if (tutorOff() || read(GUEST_KEY) === '1') return;
    this.world = null;
    this.guest = true;
    this.steps = GUEST_STEPS;
    this.start();
  }

  start() {
    this.on = true;
    this.i = -1;
    this.camMoved = false;
    this.crateSeen = false;
    // Beside the other two run-scoped latches: Replay is a second run of the
    // same tour, and it has to be able to ask again.
    this.offerTaken = false;
    this.el.hidden = false;
    document.body.classList.add('tutoring');
    this.go(0);
  }

  /**
   * The way out, from the button, from Esc, or from the last card.
   *
   * It marks the world done in every case including "skipped", which is the
   * whole of what Skip means: the offer was made and turned down, and making it
   * again on the next load is the tutorial nagging. The Menu's Replay row is the
   * way back — see `replayTutor`.
   */
  quit(why = 'done') {
    if (!this.on) return;
    this.on = false;
    this.step = null;
    // The one part of the tour that is not inside `this.el`, so hiding the card
    // does not take it with it — a green frame left standing on a shelf after
    // Skip is the tour still pointing at something.
    this.aim = null;
    this.scene?.setTutorTarget?.(null);
    this.el.hidden = true;
    this.el.classList.remove('show');
    document.body.classList.remove('tutoring');
    if (this.guest) write(GUEST_KEY, '1');
    else if (this.world) { addTo(DONE_KEY, this.world); dropFrom(NEW_KEY, this.world); }
    // The key list is a keyboard thing, so it is not offered to a hand that has
    // no keyboard — the same rule the rail's key caps and the shut-shop chip
    // keep. What is left is the half that is true either way.
    if (why === 'done') {
      this.ui.toast(pillDrives()
        ? 'Tutorial finished — have at it'
        : 'Tutorial finished — press / for the key list');
    }
  }

  // -- the script -----------------------------------------------------------

  go(i) {
    if (i >= this.steps.length) { this.quit('done'); return; }
    this.i = i;
    this.step = this.steps[i];
    // A step that has nothing to teach in this shop — no crate on the floor, no
    // box on your shoulder — is stepped over rather than shown and failed. Asked
    // BEFORE `arm`, so a skipped step never opens a menu on its way past.
    if (this.step.skipWhen?.(this)) { this.go(i + 1); return; }
    this.step.start?.(this);
    this.step.arm?.(this);
    this.paint();
    // Two frames before the measure, for the reason the tooltip takes two: a
    // menu `arm` just opened is not laid out yet, so a rect read now is the rect
    // of where it used to be.
    requestAnimationFrame(() => requestAnimationFrame(() => this.place()));
  }

  next() { this.go(this.i + 1); }

  /** Every snapshot. The predicate, and nothing else. */
  update(state) {
    this.state = state;
    if (!this.on || !this.step) return;
    // Remembered rather than asked, so the "buy" step is satisfied by a shop
    // that already had a crate on the pad — a world restored mid-tour, or a
    // second player unloading the van while you read the card.
    if ((state?.deliveries ?? []).some((d) => !d.rubbish && lotSize(d) > 0)) this.crateSeen = true;
    // Before the predicate, and every snapshot rather than once on open: a
    // step that has to keep a strip open or a tab selected is holding the shop
    // in a shape the player can walk out of at any moment, and it is also where
    // a two-phase step latches what it has seen (`crate`).
    this.step.nudge?.(this);
    if (this.step.done?.(this)) { this.next(); return; }
    // The target moves — a crate is carried off, a menu scrolls, the shop
    // re-flows — so the hole is re-measured every frame rather than at open.
    this.place();
  }

  /**
   * How much of the day this hire has on the till.
   *
   * Read off the roster rather than off the panel that is drawing it, because
   * the panel holds a local `weights` map it repaints from — so a step that
   * watched the DOM would tick the moment the number on screen moved, whether or
   * not the shop was ever told.
   */
  jobSig() {
    const who = (this.state?.roster ?? [])[0];
    if (!who) return null;
    return (who.jobs ?? []).map((j) => `${j.job}:${j.weight}`).sort().join(',');
  }

  // -- drawing --------------------------------------------------------------

  render() {
    this.el.innerHTML = `
      <div class="tt-mark tt-ring" hidden></div>
      <div class="tt-mark tt-pulse" hidden></div>
      <div class="tt-card">
        <div class="tt-bot">${FACE}</div>
        <div class="tt-said">
          <div class="tt-kicker"></div>
          <p class="tt-say"></p>
          <p class="tt-hint"></p>
          <!-- A step's own question about the SHOP, asked in words with the
               answer as a link inside them. See the offer slot on the last
               step. Hidden on every other card, and on this one once the shop
               has no question left to be asked.

               No backticks in here: they would end the template literal this
               comment is written inside. -->
          <p class="tt-offer" hidden><span></span>
            <button class="tt-link" type="button"></button></p>
        </div>
        <div class="tt-feet">
          <!-- Back and on, either side of the ticks. Quiet on purpose: the card
               is one instruction and the way past it is doing the thing, so
               these are the same weight as the dots they flank rather than a
               second pair of buttons competing with Next. -->
          <div class="tt-nav">
            <button class="tt-arrow tt-back" type="button" aria-label="Back">&lsaquo;</button>
            <div class="tt-dots"></div>
            <button class="tt-arrow tt-fwd" type="button" aria-label="On">&rsaquo;</button>
          </div>
          <button class="tt-next" type="button" hidden>Next</button>
          <button class="tt-skip" type="button">Skip tutorial</button>
        </div>
      </div>`;
    this.card = this.el.querySelector('.tt-card');
    this.ring = this.el.querySelector('.tt-ring');
    this.pulse = this.el.querySelector('.tt-pulse');
    this.el.querySelector('.tt-skip').onclick = () => this.quit('skipped');
    this.el.querySelector('.tt-next').onclick = () => this.next();
    /**
     * The step's own answer. Wired once here rather than re-bound in `paint`,
     * which is the same call the two above make and for the same reason: `paint`
     * runs on every step change and an `onclick` written there is a handler
     * replaced twelve times a tour. It reads the CURRENT step at press time, so
     * a card with no offer cannot be pressed into somebody else's action.
     *
     * It answers rather than advancing the tour — this is a choice about the
     * shop, and a press that also moved you on would read as a way past the
     * step. What it leaves behind is a sentence saying what just happened and
     * where to undo it, which is the half a button could not carry.
     */
    this.el.querySelector('.tt-link').onclick = () => {
      const o = this.step?.offer;
      if (!o || this.offerTaken) return;
      o.run(this);
      this.offerTaken = true;
      this.paint();
    };
    /**
     * Jump to a beat. Delegated on the row rather than bound per dot, because
     * `paint` rewrites the row's `innerHTML` on every step — handlers written
     * there would be a fresh set of them a card.
     *
     * It goes through `go` and nothing else, so a beat reached this way opens
     * exactly as it opens in play: its `start`, its `arm`, and its `skipWhen`
     * if the shop has nothing for it to teach.
     */
    this.el.querySelector('.tt-dots').onclick = (e) => {
      const i = e.target?.dataset?.i;
      if (i != null) this.go(Number(i));
    };
    this.el.querySelector('.tt-back').onclick = () => this.go(Math.max(0, this.i - 1));
    // Never off the end: `go` past the last beat is `quit`, and an arrow that
    // ends the tour is Skip wearing a chevron. The last card is left to its own
    // predicate.
    this.el.querySelector('.tt-fwd').onclick = () => this.go(Math.min(this.steps.length - 1, this.i + 1));
  }

  /** The shell of a card: run once, when a step opens. */
  paint() {
    const s = this.step;
    if (!s) return;
    // A step with no predicate is a thing to READ, so it gets a button. One
    // with a predicate must not have one — a Next beside "left-click the floor"
    // is an offer to not learn the only thing on the card.
    const next = this.el.querySelector('.tt-next');
    delete next.dataset.stranded;
    this.lostAt = 0;
    next.textContent = 'Next';
    next.hidden = !!s.done;
    this.offer();
    this.card.classList.toggle('big', !!s.big);
    this.said = null;
    this.words();
    // Where you are, as ticks rather than "4 of 10" — a count invites you to
    // work out how much is left, which is not the question the card wants asked.
    this.el.querySelector('.tt-dots').innerHTML = this.steps
      .map((s, i) => `<button type="button" data-i="${i}" title="${s.id}"`
        + ` class="${i < this.i ? 'was' : ''}${i === this.i ? ' at' : ''}"></button>`)
      .join('');
    this.el.querySelector('.tt-back').disabled = this.i <= 0;
    this.el.querySelector('.tt-fwd').disabled = this.i >= this.steps.length - 1;
    // Restart the pop, or every card after the first arrives already on screen.
    this.card.style.animation = 'none';
    void this.card.offsetWidth;
    this.card.style.animation = '';
    this.el.classList.add('show');
  }

  /**
   * The question this step is asking about the shop, and what it says once it
   * has been answered.
   *
   * `when` is asked rather than stored, because the answer can stop being true
   * while the card is up — it is a question about the shop, which somebody in
   * co-op can change from the other side of the room. `offerTaken` is checked
   * FIRST and beats it: the moment the link is pressed the setting flips, so
   * `when` goes false, and reading it first would take the sentence away in the
   * same frame as the press it is meant to acknowledge.
   */
  offer() {
    const el = this.el.querySelector('.tt-offer');
    const o = this.step?.offer;
    const show = !!o && (this.offerTaken || o.when?.(this) !== false);
    el.hidden = !show;
    if (!show) return;
    el.querySelector('span').textContent = this.offerTaken ? o.took : o.ask;
    const link = el.querySelector('.tt-link');
    link.hidden = this.offerTaken;
    link.textContent = o.label;
  }

  /**
   * What the card says, asked every frame.
   *
   * A step moves its own spotlight — the hole walks from the rail button to the
   * tile on it — so the sentence beside the hole has to walk with it, or the
   * card is describing the press before last. Written to the DOM only when it
   * actually changes, which is the same call `rail.update` makes and for the
   * same reason: this runs at 10Hz over a live canvas, and a step whose text is
   * a constant must not cost three writes a tick.
   */
  words() {
    const s = this.step;
    if (!s) return;
    const said = (v) => (typeof v === 'function' ? v(this) : v) ?? '';
    const now = [said(s.kicker), said(s.say), said(s.hint)];
    const key = now.join('\u0000');
    if (key === this.said) return;
    this.said = key;
    const [kicker, say, hint] = now;
    this.el.querySelector('.tt-kicker').textContent = kicker;
    this.el.querySelector('.tt-say').textContent = say;
    this.el.querySelector('.tt-hint').textContent = hint;
  }

  /**
   * Mark whatever this step is pointing at.
   *
   * Everything in here is in CSS pixels off `getBoundingClientRect`, so it
   * survives a resize, a scrolled panel and a bar that changed height — none of
   * which the tour is told about, and all of which move the thing it is pointing
   * at.
   *
   * IT USED TO BLACK THE SCREEN OUT, and taking that away is the whole of this
   * pass. Four boxes round a lit hole meant one press was possible at a time,
   * which is the shape Factorio threw out of their own tutorial for the reason
   * that applies here word for word: what somebody learns from it is *how to
   * get through the tutorial*, not how to run a shop. It also fought the game
   * on three fronts nobody would have predicted — the HUD had to be muted and
   * then handed back a panel at a time, the card had to be measured and pinned
   * to whatever side of the target was free, and every step had to have an
   * answer for "I cannot find what I am pointing at", because a blackout with
   * no hole in it is a game nobody can play.
   *
   * What is left is a mark and a sentence. The mark says which thing; the card
   * sits out of the way on the right and waits. Wander off, open something
   * else, go and do a different job first — the step is a predicate over the
   * snapshot, so it was never watching your presses anyway, and it is still
   * there when you come back.
   */
  place() {
    if (!this.on || !this.step) return;
    this.words();
    // Waiting on the WORLD rather than on you — the van. The card breathes so a
    // wait does not read as an instruction you are failing to follow, and
    // `strand` reads the same flag to hold its clock: a step nobody can finish
    // yet must not grow a button offering to skip the beat the tour was built
    // around.
    this.held = this.step.waiting?.(this) === true;
    this.card.classList.toggle('holding', this.held);
    const want = this.step.at?.(this) ?? null;
    const box = this.holeFor(want);
    // Before either branch below, because it belongs to neither: the small mark
    // is about a press and the veil is about a rectangle, and a step can want
    // one without the other.
    this.pulseAt(want?.pulse ?? null);

    // The mark on the thing standing in the shop, laid in the shop.
    this.scene?.setTutorTarget?.(this.aim);

    // `soft` is a target the size of the whole world view. Ringing that is
    // drawing a box round the screen, which says nothing — the world mark above
    // is what is pointing at anything on those steps.
    this.ring.hidden = !box || this.soft;
    if (box && !this.soft) {
      Object.assign(this.ring.style, {
        top: `${box.y}px`, left: `${box.x}px`, width: `${box.w}px`, height: `${box.h}px`,
      });
    }
    this.strand();
  }

  /**
   * The press INSIDE the hole.
   *
   * A hole the width of a panel says "work in here", and the supplier is forty
   * rows of identical buttons: the step that asks you to buy a case had a lit
   * panel, a sentence, and nothing anywhere saying which of the forty presses
   * it meant. `pulse` is a second selector on the same `at`, measured the same
   * way and drawn with the same mark at button size.
   *
   * Two things keep it from being a second hole, and both are what make it
   * cheap. It **cuts nothing** — the veil is decided by `at.el` alone, so the
   * whole panel stays live and buying something else off a row it never lit is
   * still yours to do. And it **never sets `lost`**: a frame where the button is
   * not in the document (the list scrolled, the drill-down open, a repaint
   * mid-flight) is a frame with no pulse, where `lost` would be a blackout
   * offering to give up on the step.
   *
   * The clip is the half that is not obvious. `getBoundingClientRect` answers
   * for a row scrolled out of its own panel exactly as it answers for one you
   * can see, so an unclipped mark is a ring pulsing over the search box — the
   * same trap `holeFor`'s `scrollIntoView` note is about, arriving from the
   * other side. It is measured against the SCROLLER rather than the panel,
   * because the head, the tabs and the search box are inside the panel too.
   */
  pulseAt(sel) {
    const el = this.pulse;
    if (!el) return;
    const t = sel ? document.querySelector(sel) : null;
    const r = t?.getBoundingClientRect();
    if (!r?.width || !r?.height) { el.hidden = true; return; }
    // Its middle rather than its edges: a row half under the head strip is
    // still the row being pointed at, and a test on the edges would blink the
    // mark on and off as the list moved a pixel.
    const clip = t.closest('.pnl-mid, #panel-body, .hud')?.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    if (clip && (cy < clip.top || cy > clip.bottom)) { el.hidden = true; return; }
    el.hidden = false;
    Object.assign(el.style, {
      top: `${Math.round(r.top - 3)}px`,
      left: `${Math.round(r.left - 3)}px`,
      width: `${Math.round(r.width + 6)}px`,
      height: `${Math.round(r.height + 6)}px`,
    });
  }

  /**
   * The way out of a step that cannot be finished.
   *
   * Every `done` in the script is a question about the shop, which is what makes
   * them honest and is also the one way this can wedge: a crate somebody else
   * unloaded, a van that never came, a tile of the bar in a tab you browsed away
   * from. None of those is a bug in the step and all of them look identical from
   * in here — a card asking for something that is not there.
   *
   * So the rule is about TIME rather than about any particular failure. Six
   * seconds with nothing to point at and the card grows the button it
   * deliberately does not have. Skip has been on every card the whole time; this
   * is the smaller press, the one that gives up on the step rather than on the
   * tour.
   *
   * `Date.now()` rather than the shop's clock, for the reason the pause stamp
   * gives: what is being measured is real seconds spent looking at a card, and
   * the shop's clock is the thing that might have stopped.
   */
  strand() {
    const btn = this.el.querySelector('.tt-next');
    if (!this.lost || this.held) {
      this.lostAt = 0;
      if (btn.dataset.stranded) {
        delete btn.dataset.stranded;
        btn.textContent = 'Next';
        btn.hidden = !!this.step?.done;
      }
      return;
    }
    this.lostAt ||= Date.now();
    if (Date.now() - this.lostAt < 6000 || btn.dataset.stranded) return;
    btn.dataset.stranded = '1';
    btn.textContent = 'Carry on';
    btn.hidden = false;
  }

  /**
   * The rectangle a step is pointing at, in screen pixels.
   *
   * Three answers rather than two, and the third is the one that keeps this
   * safe. A step with no `at` at all wants the veil WHOLE — the first and last
   * cards, which are read rather than acted on, and which carry a button.
   * A step that named a target and cannot find it — a crate somebody else
   * carried off, a tile of the bar in a tab you have browsed away from, a panel
   * mid-render — wants NO veil: it does not know what to light, and a blackout
   * with no hole in it is a game nobody can play. So `lost` is the third answer,
   * and `place` reads it as "get out of the way".
   */
  holeFor(want) {
    // Anything that is not an element target forgets which one was last brought
    // into view, so coming back to the same control scrolls to it again — a step
    // that points into the shop and then back at the bar is two arrivals, and
    // the strip may well have been dragged in between.
    if (!want || 'world' in want || !want.el) this.shown = null;
    if (!want) { this.aim = null; this.lost = false; this.soft = false; return null; }
    const pad = want.pad ?? 4;

    if ('world' in want) {
      // A point in the shop, handed to the renderer to mark in the shop — see
      // the header for why it is not a rectangle on the page. The height is
      // still each target's own and is now what the chevron floats at rather
      // than where the mark is drawn — see `Scene.setTutorTarget`.
      this.aim = want.world
        ? { x: want.world.x, z: want.world.z, y: want.y ?? 0.8 }
        : null;
      this.lost = !want.world;
      // A world target is always `soft`: the hole is the whole canvas, so the
      // veil's own frame would be a box round the screen and the card would pin
      // to a corner of it. The mark in the shop is what points at anything here.
      this.soft = true;
      const c = document.getElementById('game')?.getBoundingClientRect();
      return c && want.world ? { x: c.left, y: c.top, w: c.width, h: c.height } : null;
    }

    this.aim = null;
    this.soft = !!want.soft;
    // `up` climbs from the thing that can be NAMED to the thing that should be
    // LIT. A stepper's + carries the only attribute worth selecting on and is
    // half the control — see the jobs step.
    let t = want.el ? document.querySelector(want.el) : null;
    if (t && want.up) t = t.closest(want.up) ?? t;
    // A LIT CONTROL THAT IS SCROLLED OFF ITS OWN STRIP IS NOT LIT.
    //
    // The bar scrolls sideways and holds more entries than fit, so the hole for
    // "pick the Cooler" was cut over whatever happened to be at those
    // coordinates — on a narrow screen, off the end of the strip entirely, which
    // draws as a card pointing at the edge of the shop. `renderHotbar` already
    // makes this call for `.tool.on` and it cannot help here: the whole point of
    // the step is that the thing is NOT the one selected yet.
    //
    // Keyed on the NODE rather than on the selector, which is the half that
    // keeps it from being a fight. `block/inline: 'nearest'` is a no-op on
    // something already in view, but running it every frame would still snap the
    // strip back the instant you dragged it — and the bar rebuilds from
    // `innerHTML`, so a selector that resolved once would never scroll again
    // after a repaint reset the strip. A new node is a new bar; the same node is
    // a player scrolling, and that is theirs.
    if (t && t !== this.shown) {
      this.shown = t;
      t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    const r = t?.getBoundingClientRect();
    if (!r?.width || !r?.height) { this.lost = true; return null; }
    this.lost = false;
    return { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
  }
}
