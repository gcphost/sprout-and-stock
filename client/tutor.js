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
import { REACH, isWalkableTile, insideStore, tileAt } from '../shared/build.js';
import { artForPiece, artForGround } from './thumb.js';
import { pieceOffered, toolRevealed } from '../shared/reveal.js';
import { T } from '../shared/tiles.js';

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
/**
 * ...and which MINI-LESSONS this person has been shown — see `LESSONS`.
 *
 * A list, like `DONE_KEY`, but of lesson ids rather than of worlds, and that is
 * the whole of the difference: a lesson is about a MACHINE and the machine is
 * the same machine in every shop. Somebody who has been shown what a loader is
 * for does not need telling again at their second shop, or at a friend's.
 *
 * Same argument as `GUEST_KEY` exactly, one axis along: the host's tour is about
 * a shop, so a second shop earns a second telling; the guest tour and these are
 * about a pair of hands and a piece of kit, so they are told once per person.
 */
const LEARNED_KEY = 'sns-tutor-learned';

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

/**
 * ...and the lessons with it, which is the half a Replay row would otherwise
 * silently not do.
 *
 * Skipping a lesson marks it learned — that is what Skip means everywhere in
 * here — so without this, one press of "not now" on the conveyor card is a press
 * that says "never", on the one screen where somebody has least idea what they
 * are turning down. The Menu's Replay is the way back for the tour and it has to
 * be the way back for these, or there are two kinds of tuition and only one of
 * them can be asked for again.
 *
 * It takes no world id, unlike everything above it: these are marks about a
 * person, so there is nothing to name.
 */
export const forgetLessons = () => write(LEARNED_KEY, '');

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
 * A tile to send somebody to — the delivery bay, if this shop has one.
 *
 * "Click a bit of floor" is an instruction with no target, on the one card whose
 * whole job is teaching you that clicking a target is how you get anywhere — so
 * the tour picks one and rings it, the same way it rings a crate.
 *
 * WHICH tile changed with the running order. It used to hunt for a cell about
 * five steps away and INSIDE the building, on the reasoning that the shop is a
 * small building in a big field and a tour whose opening move sends you outdoors
 * has taught you to leave. That was right while the next four beats were about
 * the supplier and the crew. It is wrong now: a van is on the road from the
 * moment the world is made (`starterOrder`), the very next card asks for the
 * crate it drops, and a first walk to a nice bit of shop floor is a journey you
 * make and then immediately make again in the other direction.
 *
 * So it aims at the bay, which turns the two into one — you learn the walk, and
 * you arrive where the lesson after it happens, next to a lorry backing in. The
 * indoor hunt is still here underneath, for a shop whose bay has been painted
 * out or is somehow unreachable: a ringed tile you cannot walk to is worse than
 * a boring one.
 *
 * It is worked out ONCE, in `start`, and held: asked every frame it would
 * re-answer as you moved, so the marker would slide away and the walk would
 * never end. `isWalkableTile` is the shop's own test off the layout the renderer
 * is holding — a ring on a tile the server will refuse to route to is the
 * green-ghost bug wearing a marker.
 */
function spotToWalk(t) {
  const me = meOf(t);
  const L = t.scene?.storeLayout;
  if (!me || !L) return null;
  const from = { x: Math.round(me.x), z: Math.round(me.z) };
  const dist2 = (c) => Math.hypot(c.x - from.x, c.z - from.z);

  // The bay first — the cell of it nearest to you, so the walk is the short way
  // in rather than a march to the far corner of a pad you painted wide.
  const bay = [];
  for (let z = 0; z < (L.h ?? 0); z += 1) {
    for (let x = 0; x < (L.w ?? 0); x += 1) {
      if (tileAt(L, x, z) !== T.BAY || !isWalkableTile(L, x, z)) continue;
      bay.push({ x, z });
    }
  }
  if (bay.length) {
    const near = bay.slice().sort((a, b) => dist2(a) - dist2(b))[0];
    // Standing on it already is not a journey, and the card is about the walk.
    if (dist2(near) >= 2.5) return near;
  }

  // Every cell in the building, at about five steps, so the walk is a walk
  // rather than a step — and a shop with no room to cross still answers with
  // whatever it has instead of sending you out of the door.
  let best = null;
  for (let z = 0; z < (L.h ?? 0); z += 1) {
    for (let x = 0; x < (L.w ?? 0); x += 1) {
      if (!isWalkableTile(L, x, z) || !insideStore(L, x, z)) continue;
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

/**
 * The cheapest piece of a kind in the catalogue, so a step lights one you can
 * afford — and, more to the point, one that is actually on the bar.
 *
 * Keyed on `kind ?? id`, which is `kindOf`'s own read-time default said in the
 * client: a row written before kinds and pieces split names itself.
 */
function cheapestOf(t, kind) {
  const rows = (t.ui.catalog?.fixtures ?? [])
    .filter((f) => (f.kind ?? f.id) === kind)
    // ...AND STILL OFFERED, which is the half a lesson found. `RETIRED_PIECES`
    // is a filter on the PALETTE and the catalogue keeps every retired row —
    // deliberately, because seven live shops have hen houses standing in them
    // (see `shared/reveal.js`). So the cheapest `pen` in the catalogue is a
    // Beehive at 120, and a card explaining what a vat is would have shown a
    // picture of a beehive nobody can buy. Nothing errors and nothing logs it:
    // it reads as the art being wrong.
    .filter((f) => pieceOffered(f.id));
  return rows.slice().sort((a, b) => (a.cost ?? 1e9) - (b.cost ?? 1e9))[0] ?? null;
}

/** The cheapest chiller in the catalogue, so the step lights one you can afford. */
const cheapestFreezer = (t) => cheapestOf(t, 'freezer');

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
    id: 'take-all',
    kicker: 'Stock',
    /**
     * THE BOX FIRST, AND SINGLE UNITS AFTER IT.
     *
     * This used to run the other way — take one unit off a crate, shelve it,
     * then lift the whole box — and it fought the shop the whole way.
     * `errandAction` is explicit that "empty-handed at a crate is a LIFT", so
     * tapping a box you are not stood at walks you over and shoulders it about
     * half a second after you arrive, before there is anything to press. A card
     * asking for one unit described a state you could only reach by NOT doing
     * what its own first sentence told you to.
     *
     * So the order follows what the game actually does. The tap on a crate
     * across the shop is the whole-box lift, which is the one press the walk
     * produces; the pair of gestures about SINGLE units is then taught at the
     * shelf, where a tap is a unit and a hold is the lot with nothing walking
     * in between.
     */
    say: (t) => {
      const c = nearestCrate(t);
      if (!c) return 'Van is on its way. Crates get left on the pad round the back.';
      return perInput('Click the crate. You walk over and pick the whole box up.',
        'Tap the crate. You walk over and pick the whole box up.');
    },
    hint: (t) => (nearestCrate(t)
      ? perInput(
        'Clicking something you are not stood at walks you there and then does '
          + 'the job. A box carries far more than your arms do.',
        'Tapping something you are not stood at walks you there and then does '
          + 'the job. A box carries far more than your arms do.',
      )
      : 'Somebody has to carry it in off the pad. Today that is you.'),
    arm(t) { t.ui.toggleBuild?.(false, { quiet: true }); t.ui.showBar(null); },
    at: (t) => ({ world: nearestCrate(t), y: CRATE_Y }),
    // Nobody's fault and nothing to press. Without this the card reads as an
    // instruction you are failing, and the stranded-timer offers to skip the
    // one beat the whole tour is building up to.
    waiting(t) { return !nearestCrate(t) && !meOf(t)?.haul; },
    done(t) { return !!meOf(t)?.haul; },
  },

  {
    id: 'pour',
    kicker: 'Stock',
    say: () => perInput('HOLD the RIGHT button on a shelf to tip the box in.',
      'Tap a shelf, then HOLD Stock it to tip the box in.'),
    hint: () => perInput(
      'Right drops off, and holding drops off the lot. Arrows point at every '
        + 'shelf that will take what you are carrying. It stops when the shelf '
        + 'is full; the rest stays on your shoulder.',
      'Hold Stock it to pour in everything that fits. Arrows point at every '
        + 'shelf that will take it. It stops when the shelf is full; the rest '
        + 'stays on your shoulder.',
    ),
    at: (t) => ({ world: anyShelf(t), y: SHELF_Y }),
    // A latch, because "no box on your shoulder" is also true of somebody who
    // never had one — a crate shelved by hand, or a beat reached by pressing a
    // dot on the card.
    start(t) { this.lifted = !!meOf(t)?.haul; },
    nudge(t) { if (meOf(t)?.haul) this.lifted = true; },
    done(t) { return this.lifted && !meOf(t)?.haul; },
    skipWhen(t) { return !meOf(t)?.haul && !nearestCrate(t); },
  },

  {
    id: 'take-one',
    kicker: 'Stock',
    /**
     * ...and the same shelf, a unit at a time. Stood at it already, which is
     * the whole reason this beat comes after the pour rather than before it:
     * a tap on a thing you are AT is one unit, and a tap on a thing across the
     * shop is a walk that ends in a job. Only one of those two sentences is
     * about a single unit, and this is the beat where it is true.
     */
    say: () => perInput('Now click that shelf once. One unit comes off it.',
      'Now tap the shelf and press Take one.'),
    hint: () => perInput(
      'A click takes one. Press and hold instead and the whole board goes into '
        + 'a crate on your shoulder. Same on every crate, shelf and machine in '
        + 'the shop.',
      'A press takes one. The rows marked HOLD want holding down — that is how '
        + 'the whole board goes into a crate. Same for every crate, shelf and '
        + 'machine in the shop.',
    ),
    at: (t) => ({ world: anyShelf(t), y: SHELF_Y }),
    start(t) { this.had = lotSize(meOf(t)?.carry); },
    done(t) { return lotSize(meOf(t)?.carry) > (this.had ?? 0); },
  },

  {
    id: 'put-one',
    kicker: 'Stock',
    say: () => perInput('And RIGHT-click the shelf to put it back.',
      'And press Put one on to put it back.'),
    hint: () => perInput(
      'That is the whole of it: left takes, right puts, and holding either one '
        + 'does the lot instead of one.',
      'That is the whole of it: one row takes, one puts, and the rows marked '
        + 'HOLD do the lot instead of one.',
    ),
    at: (t) => ({ world: anyShelf(t), y: SHELF_Y }),
    done(t) { return lotSize(meOf(t)?.carry) === 0; },
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
      : 'You are not doing all that yourself. Open the crew strip.'),
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
    id: 'stock',
    kicker: 'Buying in',
    // `inSupplier` rather than the id, because one press into an item is still
    // being in the supplier — see `client/item-menu.js`. Asked of the id alone,
    // opening a row to look at what it costs swaps the copy back to "open the
    // supplier" and points the veil at a rail button, over a panel that IS the
    // supplier. You can order from in there too, which is the same `done`.
    say: (t) => (inSupplier(t)
      ? 'Buy a case of something cheap.'
      : 'That crate came free. Open the supplier for more.'),
    hint: (t) => (inSupplier(t)
      ? 'It comes on the van to the pad round the back, same as the first one, '
        + 'and you carry it in from there — or your crew do.'
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
    /**
     * An order placed SINCE the card opened, and never "is there one".
     *
     * A new shop is created with a van already on its way (`starterOrder` in
     * server/worlds.js) — which is what lets the four gesture beats above come
     * first, and which makes every level test here true on the frame this
     * It used to accept "a crate has been seen on the floor" as well, which is
     * the same trap wearing the other hat: by this point there is one on the
     * pad, because the beat about carrying it in is four cards back.
     *
     * So it counts. Anything ordered from here — one press or six — is more
     * than there was, and a shop where the first van has already landed reads
     * zero pending and needs an order all the same.
     */
    start(t) { this.from = (t.state?.orders?.pending ?? []).length; },
    done(t) { return (t.state?.orders?.pending ?? []).length > (this.from ?? 0); },
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
// The lessons
// ---------------------------------------------------------------------------

/** The layout the renderer is holding — where every conveyor cell lives. */
const layoutOf = (t) => t.scene?.storeLayout ?? null;
const beltsOf = (t) => layoutOf(t)?.belts ?? [];
const armsOf = (t) => layoutOf(t)?.arms ?? [];

/**
 * A picture of a piece, drawn from the piece's own catalog row.
 *
 * `artForPiece` is what a palette button shows, so the thing on the card is
 * literally the thing on the bar — same model, same camera, same sun, same
 * colours — and a piece somebody restyles tomorrow restyles its lesson with no
 * second picture to keep in step. That is `client/thumb.js`'s own argument
 * about the palette, and it applies here for a sharper reason: a lesson that
 * drew its own diagram of a conveyor would be a drawing of a conveyor that the
 * shop has never once drawn.
 *
 * Cheapest of the kind, for the reason `cheapestFreezer` gives: it is the one
 * you have almost certainly got.
 */
function artOf(t, kind, piece = null) {
  // ...unless the page names one, which is for the kind whose cheapest row is
  // not what the word means. The cheapest `shelf` is a Produce Table — a low
  // open table, correctly filed and the wrong picture over a sentence that says
  // "a shelf", which is this file's own rule about a page's art being its
  // subject.
  const row = piece
    ? (t.ui.catalog?.fixtures ?? []).find((f) => f.id === piece)
    : cheapestOf(t, kind);
  if (!row) return null;
  // Ground and furniture are the same table and two different pictures. A brush
  // row carries a `surface` and no model, so `artForPiece` answers null for it
  // — silently, which is a card about the culture floor with a hole where the
  // floor should be. This is `artForTool`'s own fork said with the one field
  // that tells them apart.
  return row.surface ? artForGround(row.surface) : artForPiece(row, kind);
}

/**
 * IS THIS PAGE ABOUT SOMETHING YOU CANNOT BUILD YET?
 *
 * A briefing covers a whole build tab, so most of the time it covers pieces the
 * ladder has not handed over — a shop laying its first conveyor is five hundred
 * sales away from the sorter on page three. Leaving those pages out is the
 * obvious answer and the wrong one: it makes the briefing a different length
 * every time you open it, and it hides the one thing worth knowing about a piece
 * you have not got, which is that it exists and is coming.
 *
 * So the page stays and says so. `toolRevealed` is the palette's own test asked
 * with the palette's own arguments, or the card and the bar would disagree about
 * what you can build — which is the green-ghost bug wearing a tutorial.
 *
 * A shop with the ladder switched off answers `true` for everything, which is
 * the right answer: nothing is coming, because it is all already here.
 */
function comingSoon(t, kind) {
  if (!kind) return false;
  const done = new Set();
  for (const m of t.ui?.state?.milestones ?? []) if (m?.done) done.add(m.id);
  return !toolRevealed({ kind, id: kind }, done, t.ui?.state?.reveal === true);
}

/**
 * WHAT A LESSON IS, AND WHAT IT IS NOT.
 *
 * The tour stops at "you can run a shop", and that is the right place for it to
 * stop: a tutorial that keeps going is a tutorial people skip. What it leaves
 * unsaid is everything the shop grows into — the beds, the vats, the kitchen,
 * the skip, and the conveyors, which arrive four hundred sales after anybody
 * read a card.
 *
 * **It is a BRIEFING, not a second tour**, and that is the whole design. The
 * first cut of this was the tour's shape pointed at a machine — a lit target, a
 * predicate over the snapshot, "stand a loader beside a shelf" — and it was
 * wrong in two ways that took one screenshot each to see.
 *
 * A lesson's trigger is a press that has ALREADY HAPPENED. So its first beat
 * cannot be that press: the opening card said "drag along the floor to lay a
 * run" at somebody who had just dragged along the floor and laid a run, which is
 * not teaching, it is describing. The `skipWhen` it needed was the tell — a step
 * that has to check whether it is redundant is a step whose trigger already
 * knows the answer.
 *
 * And a lesson runs in a shop it knows nothing about. The loader beat asked for
 * a shelf beside the run; the shop it fired in **had no shelves in it**, so the
 * card sat there naming a thing that did not exist, on a predicate that could
 * never come true. The tour can demand a press because it runs on day one in a
 * shop the game itself furnished. Nothing else in the game may, and there is no
 * amount of care in a predicate that fixes it — the fault is the demand.
 *
 * So: **a lesson tells you what a thing IS and asks nothing.** A few pages, a
 * picture of the piece on each, Next through them, done. No target, no veil, no
 * predicate, nothing armed, no build mode touched, nothing that can wedge. What
 * the player does with it afterwards is the game.
 *
 * That leaves three things it still has to get right.
 *
 * **`when` is what being STUCK looks like, never what owning one looks like.**
 * "There is a conveyor" is a level, and this file's guest tour is written around
 * what levels do here: a shop on day 200 with forty belts would open a briefing
 * about conveyors at somebody who has thirty loaders. So the belt lesson asks
 * for *a run with nothing lifting off it* — true of somebody who has just laid
 * track, false of everybody past it. Both halves are needed: belts alone is the
 * level trap, and no loader alone is true of every shop that never heard of
 * conveyors, which is most of them.
 *
 * **A lesson may not down tools.** `start` sends `crew-idle` for the length of
 * the tour, which is free in a shut, empty shop on day one and is a shop that
 * stops trading on day forty.
 *
 * **And it may never point at a palette entry.** The tour's `TUTORIAL_KINDS`
 * (`shared/reveal.js`) exists because a card naming a tool that is not on the
 * bar reads as the tutorial being broken. A briefing names nothing to press, so
 * it cannot land there — which is the second thing dropping the guidance bought.
 *
 * ### ONE PROP A PAGE, AND WRITTEN FOR A SEVEN-YEAR-OLD
 *
 * A page is about one thing you can point at in the shop, and it shows that
 * thing's own picture. Not "the conveyor system" — the conveyor, then the
 * loader, then the sorter. Somebody who reads one page and stops has learnt one
 * whole object rather than a quarter of a concept.
 *
 * And the words are for a child, because the person these are actually for is
 * one. Short sentences. Real nouns — box, shelf, line, hands — and none of the
 * words this codebase uses for the same things: `run`, `cell`, `unit`,
 * `backpressure`, `terminus`, `stray`. The first cut said "a belt cell with a
 * pair of hands" and "R sets where the run carries on rather than which unit it
 * fills", which is exact, is nine words shorter, and cannot be read by anybody
 * who does not already know the answer.
 *
 * Simple is not vague, and that is the part to hold on to: every sentence here
 * is literally true of the sim. "It reaches all four of its sides" is
 * `armReach`; "they queue up rather than falling off" is backpressure; "sends
 * the box to a line that can actually put it somewhere" is the splitter
 * choosing by where the goods CAN go. Writing it simply meant writing it
 * ACCURATELY — every place the plain sentence came out wrong was a place the
 * jargon had been hiding that it was wrong.
 *
 * `{ id, when, toast, steps }`, and a step is `{ id, kicker, art, say, hint }`.
 * `id` is the mark and never changes; renaming one re-teaches it to everybody
 * who has already been shown.
 */
const LESSONS = [
  /**
   * THE SHOP FLOOR — the five things you stand out here, and the four rules
   * about them the tour never had room for.
   *
   * The tour teaches a shelf on day one, and it teaches the one thing a shelf is
   * for: goods go on it and people buy them off it. What it cannot reach is that
   * a unit of shelving is *three* things — an ordinary one, a cold one and a hot
   * one — that the wrong one of the three is no better than none, and that a
   * till has a ladder on it whose top rung is a decision rather than an upgrade.
   * All four are invisible: a chicken going off in a chiller looks exactly like
   * a chicken keeping in one, and a till nobody can queue at looks exactly like
   * a till.
   *
   * It is `owns` rather than `when` for the Farm's reason — none of those four
   * has a stuck state you can see across the room, so there is no honest
   * predicate to write — and the count takes in the whole tab, which is what
   * makes the trigger "you have just stood something new on the shop floor"
   * rather than "you own shelving", which is every shop that exists.
   */
  {
    id: 'shop',
    group: 'shop',
    // `shelves` carries all three kinds of shelving, which is why one array
    // covers the first three pages.
    owns: (t) => ['shelves', 'checkouts', 'bins']
      .reduce((n, k) => n + (layoutOf(t)?.[k] ?? []).length, 0),
    toast: 'The shop floor — the ? on the build bar brings that back',
    steps: [
      {
        id: 's-shelf',
        kicker: 'The shelf',
        kind: 'shelf',
        piece: 'shelf',
        say: 'A shelf is what people take things off. One shelf holds a few different things at once, not just one.',
        hint: 'Hold on a shelf to open it up. In there you can keep a space on it '
          + 'for one thing — your robots then fill it with that and nothing else, '
          + 'and the shop buys more when it runs low. It is also where you say what '
          + 'to charge. People take things off the side it faces, so leave them room '
          + 'to stand there. A dearer shelf holds more, and more kinds at once.',
      },

      {
        id: 's-freezer',
        kicker: 'The chiller',
        kind: 'freezer',
        say: 'Frozen food goes off fast on an ordinary shelf. A chiller is the only place it keeps.',
        hint: 'Things last about four times as long in one. It takes frozen food and '
          + 'nothing else — a loaf will not go in — so buy the chiller before you '
          + 'order anything frozen, or the delivery sits in its box with nowhere to go.',
      },

      {
        id: 's-warmer',
        kicker: 'The hot counter',
        kind: 'warmer',
        /**
         * The one fact a boolean could not say, which is why this piece exists:
         * the wrong special fixture is no better than no special fixture. A
         * roast chicken in a chiller used to come back as "where it wants to
         * be", and it still LOOKS like a sensible place to have put it.
         */
        say: 'A hot counter is the same idea the other way round. Hot food only.',
        hint: 'Roast chicken and pies want keeping warm, and a chiller is no better '
          + 'for them than an ordinary shelf — it has to be a hot counter or it goes '
          + 'off just the same. Anything that is not hot food will not go in one.',
      },

      {
        id: 's-till',
        kicker: 'The till',
        kind: 'checkout',
        say: 'A till is where people pay. Somebody has to be behind it — one of your robots, or you.',
        hint: 'Leave a clear line of squares beside it for people to queue in, or '
          + 'they have nowhere to wait. The money piles up on the counter and you '
          + 'pick it up by walking over it. A dearer till serves people faster, and '
          + 'the best one lets people pay for themselves — slower, but with nobody '
          + 'stood there at all, so it still empties a queue on a busy afternoon.',
      },

      {
        id: 's-bin',
        kicker: 'The skip',
        kind: 'bin',
        say: 'A skip is somewhere to throw things away.',
        hint: 'Food that nobody buys goes off in the end, and with a skip in the shop '
          + 'your robots carry the rotten stuff out to it instead of it just going. '
          + 'They will never decide your good food is rubbish — that is your call, and '
          + 'you can carry anything over and drop it in yourself. Once it is in the '
          + 'skip it is gone, so nothing comes back out onto a shelf.',
      },
    ],
  },

  /**
   * THE BACK OF HOUSE — everything that moves stock without anybody walking it.
   */
  {
    id: 'logistics',
    group: 'logistics',
    owns: (t) => ['belts', 'arms', 'sorters', 'packers', 'unders', 'lifts']
      .reduce((n, k) => n + (layoutOf(t)?.[k] ?? []).length, 0),
    toast: 'Logistics — the ? on the build bar brings that back',
    steps: [
      {
        id: 'l-belt',
        kicker: 'The conveyor',
        kind: 'belt',
        say: 'A conveyor is a moving floor. Put a box on it and it carries the box along for you.',
        hint: () => perInput(
          'It goes the way it points, and you drag to lay a whole line in one go — '
            + 'every piece turns to follow you, so corners are free. To put a box on, '
            + 'carry one over, stand next to the line and hold the RIGHT mouse button. '
            + 'You and your robots walk straight over the top of them.',
          'It goes the way it points, and you drag to lay a whole line in one go — '
            + 'every piece turns to follow you, so corners are free. To put a box on, '
            + 'carry one over, stand next to the line and hold "Set the crate down '
            + 'here". You and your robots walk straight over the top of them.',
        ),
      },

      {
        id: 'l-arm',
        kicker: 'The loader',
        kind: 'arm',
        /**
         * THE ONE FACT THIS BRIEFING EXISTS FOR.
         *
         * A belt runs PAST a shelf. It does not stock it, it never has, and
         * nothing on screen says so — so a run laid from the bay to the aisle
         * looks exactly like a working delivery line and quietly carries every
         * box to its own last cell and stops.
         */
        say: 'A conveyor drives straight past your shelves. It never puts anything on one. A loader does.',
        hint: 'A loader is a conveyor piece with hands. Put one in the middle of '
          + 'your line with a shelf right next to it, and it lifts boxes off the '
          + 'line and fills the shelf. It can reach all four of its sides, so one '
          + 'loader can feed two aisles at once. If the boxes ever stop moving, the '
          + 'shelf at the end is full — they queue up behind each other rather than '
          + 'falling off, and start again the moment there is room.',
      },

      {
        id: 'l-sorter',
        kicker: 'The sorter',
        kind: 'sorter',
        say: 'A sorter is a crossroads for boxes.',
        hint: 'When a box reaches it, it looks down each way out and sends the box to '
          + 'a line that can actually put it somewhere. Bread ends up at the bread '
          + 'shelf and ice cream ends up at the freezer, and you never have to tell it '
          + 'which is which. Press R to point the side branch where you want it.',
      },

      {
        id: 'l-packer',
        kicker: 'The packer',
        kind: 'packer',
        say: 'A packer is a box that stands still and fills itself from the boxes going past.',
        hint: 'Deliveries turn up as half-empty boxes, and a robot carrying a '
          + 'half-empty box walks just as far as one carrying a full box — so three '
          + 'half-boxes is three trips across the shop. A packer takes what it wants '
          + 'out of each box that passes, lets the rest carry on, and lets go once it '
          + 'is full. One full box, one trip.',
      },

      {
        id: 'l-under',
        kicker: 'The tunnel',
        kind: 'under',
        say: 'A tunnel has two ends. Boxes go in one and come out the other, underneath everything in between.',
        hint: 'Put the two ends up to four squares apart, both facing the way the '
          + 'boxes travel. The squares in the middle stay yours — walk on them, build '
          + 'on them, or run another line straight over the top. It is how you get a '
          + 'line under an aisle, through a wall, or past its own way back.',
      },

      {
        id: 'l-lift',
        kicker: 'The lift',
        kind: 'lift',
        say: 'A lift joins the floor to the ceiling.',
        hint: 'You can run conveyors along the ceiling, high above everything, where '
          + 'they take up no room at all — the shelves and the floor underneath carry '
          + 'on exactly as they were. A lift is the piece that joins the two. Whatever '
          + 'feeds it decides which way it goes: a box that arrives along the floor '
          + 'goes up, and one that arrives from the ceiling comes down. Press R to '
          + 'pick which side it comes out.',
      },
    ],
  },

  /**
   * ...AND THE FARM, which is the other half of the shop nothing explains.
   *
   * A rack is the second thing anybody builds and the first that is not shop
   * floor, and every one of its three steps is invisible: a rough tray has to be
   * turned before it takes a seed, the seed is bought out of the rack's own menu
   * rather than from the supplier, and what you pick fills your hands and then
   * boxes itself at your feet.
   */
  {
    id: 'farm',
    group: 'farm',
    owns: (t) => ['plots', 'pens'].reduce((n, k) => n + (layoutOf(t)?.[k] ?? []).length, 0),
    toast: 'The farm — the ? on the build bar brings that back',
    steps: [
      /**
       * ONE PAGE, not two, and the reason is the picture rather than the words.
       *
       * Planting and picking were a page each and both drew the rack, because
       * both are about the rack — so the second card was the same photograph
       * with a different caption, which reads as the briefing having got stuck.
       * The rule: **a page is one thing you can point at**, so two pages about
       * one object is one page.
       */
      {
        id: 'f-rack',
        kicker: 'The grow rack',
        kind: 'plot',
        say: 'A grow rack grows one crop at a time. You plant it, it grows on its own, then you pick it.',
        hint: 'Hold on the rack to open it and pick a seed — each one costs a little '
          + 'and says how many minutes it takes. If the tray is rough you have to turn '
          + 'it over first, and the rack offers you that instead. When it is ready, '
          + 'hold on it again to pick. Your hands hold six things and the rest goes '
          + 'into a box at your feet, so nothing is ever wasted. A farmhand will do '
          + 'all three of those jobs for you. Racks work indoors and out.',
      },

      {
        id: 'f-pen',
        kicker: 'The vat',
        kind: 'pen',
        say: 'A vat makes food by itself. You put nothing in — you only take out.',
        hint: 'It fills on its own clock, whether you are watching or not. When it '
          + 'is full it STOPS, so it is worth emptying often: a vat left full all '
          + 'night made nothing all night. Walk over and hold on it to collect. Your '
          + 'robots will empty it too, and so will a loader sat next to it.',
      },

      {
        id: 'f-deck',
        kicker: 'The culture floor',
        kind: 'paddock',
        say: 'Paint culture floor around a vat and it runs more lines at once.',
        hint: 'Every four squares you paint is one more line. Vats standing on the '
          + 'same floor share it, so two vats on a small floor get half each — give '
          + 'them their own patches instead. And a vat can only run so many lines '
          + 'however much you paint, so a big floor under a small vat is wasted: buy '
          + 'the better vat first.',
      },

      /**
       * ...and what the farm is FOR, which is the one thing none of the props can
       * say. It also carries the farm's own stuck state — the crew stop picking
       * when there is nowhere to put anything (`hasSomewhere`), which is
       * invisible and reads as the farmhand having given up.
       */
      {
        id: 'f-sell',
        kicker: 'What you grow',
        kind: 'shelf',
        say: 'What you grow is ordinary stock. Put it on a shelf and people buy it.',
        hint: 'It costs you a seed instead of a whole delivery, so growing a thing is '
          + 'cheaper than buying it in. Some of it is worth more cooked or mixed — an '
          + 'appliance turns crops into something you can sell for more. And your '
          + 'robots stop picking if there is nowhere left to put anything, so keep a '
          + 'shelf or some space at the drop-off free for the farm.',
      },
    ],
  },
];

/** The briefing for a build tab, if that tab has one — the `?` asks this. */
export const lessonForGroup = (id) => LESSONS.find((l) => l.group === id) ?? null;

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
 * WHAT IT LOOKS LIKE IS NOT A FREE CHOICE, and the first cut of it was made as
 * though it were: a cream capsule with a 13px corner radius, a soft brown
 * outline, pale blue eyes and a smile. Every one of those is a decision the game
 * had already made the other way. Nothing in the shop is round (`--r` is 0, and
 * the note beside it says the player's head and a wheel are the only two curves
 * in the entire game); nothing in the shop is cream except the paper this card
 * is printed on, so the robot was the same colour as the thing it was standing
 * on; and no hire has ever had a mouth. It read as somebody else's app mascot
 * sat on top of the shop, which is word for word the complaint the whole Crate
 * pass was about.
 *
 * So every colour here is lifted out of `data/seed/workers.json` — `#d7dfe8`
 * chassis, `#83909f` trim, `#3b424e` visor, `#5fe0d0` glow, `#ffb43a` lamp, in
 * that order of area — and the line round it is `--ink-line` at the control
 * weight, which is the same line every rail button and palette tile wears. It is
 * boxes, because a hire is boxes.
 *
 * The eyes are two rects with a CSS animation on their height, so it blinks
 * without a frame loop and without anything to clean up. The lamp on top is the
 * one thing that is not off a worker row: it is `--good` in `ttbulb`, because a
 * tutor who is TALKING wants a tell, and it is the same green as the mark it is
 * pointing with.
 */
const FACE = `
  <svg class="tt-face" viewBox="0 0 64 64" aria-hidden="true">
    <g class="tt-ink">
      <rect x="4"  y="26" width="6"  height="14" fill="#83909f"/>
      <rect x="54" y="26" width="6"  height="14" fill="#83909f"/>
      <rect x="30" y="5"  width="4"  height="8"  fill="#6f7d92"/>
      <rect class="tt-bulb" x="28" y="1" width="8" height="5"/>
      <rect x="10" y="12" width="44" height="42" fill="#d7dfe8"/>
      <rect x="10" y="12" width="44" height="8"  fill="#c3ccdb"/>
      <rect x="16" y="24" width="32" height="16" fill="#3b424e"/>
      <rect x="20" y="46" width="24" height="4"  fill="#83909f"/>
    </g>
    <rect class="tt-eye" x="21" y="29" width="6" height="6"/>
    <rect class="tt-eye tt-eye2" x="37" y="29" width="6" height="6"/>
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
    // ...or a lesson, which is the third. Set means the run is one of `LESSONS`
    // rather than either tour, and three things read it: `start` does not down
    // tools, `quit` writes the lesson's own mark, and `maybeLesson` will not
    // open a second one over the top.
    this.lesson = null;
    // When the shop first said a lesson was wanted. A settle rather than an
    // instant open, because the trigger is a purchase and a purchase is very
    // often the middle of a drag — see `maybeLesson`.
    this.wantedAt = 0;
    this.on = false;
    this.camMoved = false;
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

    // ...and `fits` beside it, because a shorter window is one of the three
    // things that can turn the words into a scroller and `words` will not
    // re-measure for a sentence that has not changed.
    addEventListener('resize', () => { this.place(); this.fits(); });
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
    this.lesson = null;
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
    this.lesson = null;
    this.steps = GUEST_STEPS;
    this.start();
  }

  /**
   * The other other door: a piece of kit standing in the shop that is not doing
   * anything, and a person who has never been told why.
   *
   * Asked every snapshot while nothing else is up, which is what makes it a fact
   * about the SHOP rather than about a press — the same rule every `done` in
   * here obeys, so a belt laid by MCP, by a sweep, or by the friend on the other
   * side of a co-op shop counts exactly as one you laid yourself.
   *
   * The settle is the one thing here that is not a predicate, and it is about
   * the drag. A run is laid in one press, but a loader, a second run and a
   * junction are three more, and a card that arrives between two of them is the
   * interruption docs/tutorial.md warns against. Two seconds of the shop
   * standing in that state is somebody who has stopped to look at it.
   *
   * `Date.now()` and not the shop's clock, for the reason `strand` gives: what
   * is being measured is real seconds spent looking at a thing, and the shop's
   * clock is the one that might have stopped — which, while an award card is up,
   * it has.
   */
  maybeLesson() {
    if (this.on || tutorOff()) { this.wantedAt = 0; return; }
    // Not over the top of the card that congratulates you. It stops the world
    // and takes the screen, and a second card behind it is one nobody reads.
    if (this.ui?.award?.open) { this.wantedAt = 0; return; }
    const learned = listOf(LEARNED_KEY);
    /**
     * What each counting lesson's piece stood at the first time this looked.
     *
     * On the tour rather than on the lesson, and read on EVERY pass rather than
     * only when one is unlearned: a lesson recorded lazily takes its baseline
     * from whenever it happens to be asked, so a shop that builds its first
     * sorter and then its first packer would hand the packer a baseline of
     * however many packers it had by then. Recorded here, every baseline is
     * what the shop looked like when this session started.
     */
    this.had ??= new Map();
    for (const l of LESSONS) {
      if (!l.owns) continue;
      if (!this.had.has(l.id)) this.had.set(l.id, l.owns(this));
    }
    const wants = (l) => (l.owns
      ? l.owns(this) > this.had.get(l.id)
      : l.when(this) === true);
    const want = LESSONS.find((l) => !learned.includes(l.id) && wants(l));
    if (!want) { this.wantedAt = 0; return; }
    this.wantedAt ||= Date.now();
    if (Date.now() - this.wantedAt < 2000) return;
    this.wantedAt = 0;
    this.lesson = want;
    this.steps = want.steps;
    this.start();
  }

  /**
   * Run a lesson now, whatever the shop looks like — `__sns.ui.tutor.teach('belts')`.
   *
   * The same argument `award.push` makes about the top of the milestone ladder,
   * and it is sharper here. A lesson's `when` is a shop four hundred sales in
   * with a conveyor standing in it and no loader on it — so the honest way to
   * read its copy is to play to `sold-500`, lay some track, and stop. Copy that
   * expensive to look at is copy that gets fixed after it has shipped.
   *
   * It goes through `start` like everything else, so the beats open exactly as
   * they open in play, and `quit` marks it learned exactly as it would. Clear
   * that with `__sns.ui.tutor.forget()`.
   */
  teach(id) {
    const l = LESSONS.find((x) => x.id === id || x.group === id);
    if (!l || this.on) return false;
    this.lesson = l;
    this.steps = l.steps;
    this.start();
    return true;
  }

  /** ...and the way back, which is the Menu's Replay row without the tour. */
  // eslint-disable-next-line class-methods-use-this
  forget() { forgetLessons(); }

  start() {
    this.on = true;
    // The crew down tools for the length of the tour — see `crew-idle` in
    // ShopRoom. Only the owner's tour: a guest arrives into somebody else's
    // shop that is already trading, and freezing their staff while a visitor
    // reads six cards is a tutorial reaching across the room.
    //
    // ...and a LESSON never does it either, for the same reason said about the
    // same shop from the inside: these arrive on day forty, in a shop that is
    // open, and a coach mark that stops the staff is a coach mark that stops the
    // trade. The tour can afford it because a new shop is shut and empty.
    if (!this.guest && !this.lesson) this.net?.send('crew-idle', { idle: true });
    this.i = -1;
    this.camMoved = false;
    /**
     * ...and a TOUR forgets what the shop was standing at, because it is about
     * to build in it.
     *
     * `maybeLesson`'s baselines mean "what was here the last time this person
     * was left alone with the shop", and beat 11 of the tour stands a chiller on
     * the floor — which is a unit of shelving, so it moves the Shop briefing's
     * own count. Baselines taken before `maybeStart` (a snapshot can land first)
     * would read that as somebody building, and the briefing would open two
     * seconds after the card that says good luck.
     *
     * A LESSON must not do it: two lessons can want opening in the same breath
     * — a rack and a shelf inside one settle — and clearing there would take the
     * second one's delta away with the first one's card.
     */
    if (!this.lesson) this.had = null;
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
    // Back to work, however the tour ended — finished, skipped, or Esc. It is
    // not on the save, so a tab closed mid-tour comes back to a working shop
    // rather than a frozen one; this is only what puts them back inside a
    // session that stayed open.
    if (!this.guest && !this.lesson) this.net?.send('crew-idle', { idle: false });
    // The one part of the tour that is not inside `this.el`, so hiding the card
    // does not take it with it — a green frame left standing on a shelf after
    // Skip is the tour still pointing at something.
    this.aim = null;
    this.scene?.setTutorTarget?.(null);
    this.el.hidden = true;
    this.el.classList.remove('show');
    document.body.classList.remove('tutoring');
    // Skipping marks it learned, exactly as skipping the tour marks the world
    // done: the offer was made and turned down, and making it again the next
    // time you look at the thing is the tutorial nagging. Menu › Replay is the
    // way back — see `forgetLessons`, which that row now calls beside
    // `replayTutor`.
    const done = this.lesson;
    if (done) addTo(LEARNED_KEY, done.id);
    else if (this.guest) write(GUEST_KEY, '1');
    else if (this.world) { addTo(DONE_KEY, this.world); dropFrom(NEW_KEY, this.world); }
    // Cleared AFTER the mark and before anything can re-open: `maybeLesson`
    // reads `this.on`, which is already false by here, so a lesson left set
    // would be the one that is refused rather than the one that just ended.
    this.lesson = null;
    this.wantedAt = 0;
    // The key list is a keyboard thing, so it is not offered to a hand that has
    // no keyboard — the same rule the rail's key caps and the shut-shop chip
    // keep. What is left is the half that is true either way.
    //
    // A lesson says its own thing or nothing: "press / for the key list" is
    // advice for somebody four minutes into their first shop, and this one is
    // being read by somebody on day forty who has just built a conveyor.
    if (why !== 'done') return;
    if (done) { if (done.toast) this.ui.toast(done.toast); return; }
    this.ui.toast(pillDrives()
      ? 'Tutorial finished — have at it'
      : 'Tutorial finished — press / for the key list');
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
    // Cleared here rather than in `look`, so a step whose target does not exist
    // yet — the crate beat, opened while the van is still on the road — gets its
    // one look on the tick it lands rather than never. `update` asks again.
    this.looked = false;
    this.step.start?.(this);
    this.step.arm?.(this);
    this.look();
    this.paint();
    // Two frames before the measure, for the reason the tooltip takes two: a
    // menu `arm` just opened is not laid out yet, so a rect read now is the rect
    // of where it used to be.
    requestAnimationFrame(() => requestAnimationFrame(() => this.place()));
  }

  next() { this.go(this.i + 1); }

  /**
   * Point the view at what the card is pointing at.
   *
   * A ring on a crate says nothing if the crate is behind a wall, and it very
   * often is: the shop is a box with a roof-height wall on two of its four
   * sides, so a target at the back of the room is drawn behind the near wall at
   * every angle except the two you happen to be turned to. What that reads as is
   * a marker pointing at masonry.
   *
   * `focusOn` is the whole fix and it is one call, because the cutaway is
   * already keyed to the MIDDLE OF THE VIEW rather than to the player
   * (`wallHides`): move the view onto the crate and the wall in front of it
   * fades on its own, with nothing here having to know what a wall is.
   *
   * Once, when the step opens, and never per frame. The target moves — a crate
   * is carried off, the shop re-flows — and a camera that chased it would take
   * the view off whatever you had turned to look at, every tick, which is the
   * fight `nudge` is forbidden from picking with the build bar. Pan away after
   * it settles and that is yours.
   *
   * World targets only. A step pointing at a rail button is pointing at
   * something drawn over the shop rather than in it, and swinging the shop
   * underneath it would be moving the one thing the card is NOT about.
   */
  look() {
    if (this.looked) return;
    const want = this.step?.at?.(this);
    const w = want && 'world' in want ? want.world : null;
    if (!w || !Number.isFinite(w.x) || !Number.isFinite(w.z)) return;
    this.looked = true;
    this.scene?.focusOn?.(w.x, w.z);
  }

  /** Every snapshot. The predicate, and nothing else. */
  update(state) {
    this.state = state;
    // The lessons are asked here rather than anywhere else, because "is there a
    // conveyor doing nothing" is a question about the snapshot and this is the
    // one place a snapshot lands. It returns immediately in every shop that
    // wants nothing, which is nearly every frame of nearly every shop.
    if (!this.on) { this.maybeLesson(); return; }
    if (!this.step) return;
    // Before the predicate, and every snapshot rather than once on open: a
    // step that has to keep a strip open or a tab selected is holding the shop
    // in a shape the player can walk out of at any moment, and it is also where
    // a two-phase step latches what it has seen (`crate`).
    this.step.nudge?.(this);
    this.look();
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
        <!-- The title bar, which is the kicker promoted. Every other card in
             this HUD names itself in a gold band across its top (see the
             panel's own header), and this one printed its kicker as a caption
             floating on the paper — so the one card the game puts in front of
             somebody who has never played was also the one that did not look
             like the game. The bot lives in the band rather than in a gutter
             beside the words: the sentence is what is being read, and a robot
             in the margin of it is a second column competing for the same
             narrow card.

             No backticks in here — they would end the template literal this
             comment is written inside. The offer slot below says the same. -->
        <div class="tt-head">
          <div class="tt-bot">${FACE}</div>
          <div class="tt-kicker"></div>
        </div>
        <!-- A picture of the thing being talked about, drawn from its own
             catalog row — see the art slot on a lesson step. Empty on every
             card of both tours, where the thing is standing in the shop with a
             green frame round it and a second picture of it would be a diagram
             of something you are looking at. -->
        <div class="tt-art" hidden></div>
        <div class="tt-said">
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
    /**
     * The step's picture, painted here rather than in `words`.
     *
     * `words` runs every frame at 10Hz and this is a whole SVG — but the reason
     * is not cost, it is that art cannot change mid-step. A card's sentence
     * moves as its own spotlight walks (a step is one card whose hole goes from
     * the rail button to the tile); a card's picture is what the card is ABOUT,
     * and a picture that swapped under a sentence you were reading would be a
     * second thing to re-find. `artForPiece` caches per row, so this is a map
     * lookup after the first card either way.
     */
    const art = this.el.querySelector('.tt-art');
    // A page names a KIND and the picture is derived, rather than each page
    // carrying its own `art` call: one place decides how a kind is drawn, so a
    // page cannot quietly get it wrong, and the same field answers whether the
    // thing is buildable yet.
    const svg = s.kind ? artOf(this, s.kind, s.piece)
      : (typeof s.art === 'function' ? s.art(this) : (s.art ?? null));
    art.hidden = !svg;
    art.innerHTML = svg ?? '';
    art.classList.toggle('soon', !!svg && comingSoon(this, s.kind));
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
    /**
     * ...and the one thing a page adds to its own words: that you cannot build
     * it yet.
     *
     * Said TWICE and in two registers, which is deliberate rather than belt and
     * braces. The kicker is the card's title and is what you read when you flick
     * past — it has to carry it, or a briefing about six machines gives no clue
     * which four are hypothetical. The hint has to carry it too because the
     * kicker is three words and cannot say *when*, and "you cannot build this"
     * with no "yet" in it reads as a thing you are locked out of rather than a
     * thing you are on the way to.
     *
     * Written here rather than into the copy so a page's words are about the
     * MACHINE and nothing else — the same page reads correctly either side of
     * the milestone that hands it over, and nobody has to remember to take a
     * sentence out.
     */
    const soon = comingSoon(this, s.kind);
    const now = [
      soon ? `${said(s.kicker)} · soon` : said(s.kicker),
      said(s.say),
      soon
        ? `You cannot build this one yet — it turns up on the bar as the shop grows. ${said(s.hint)}`
        : said(s.hint),
    ];
    const key = now.join('\u0000');
    if (key === this.said) return;
    this.said = key;
    const [kicker, say, hint] = now;
    this.el.querySelector('.tt-kicker').textContent = kicker;
    this.el.querySelector('.tt-say').textContent = say;
    this.el.querySelector('.tt-hint').textContent = hint;
    this.fits();
  }

  /**
   * Whether the words are longer than the room they have — which is the one
   * thing that decides whether the card takes the mouse.
   *
   * The card is `pointer-events: none` on purpose (see the rule beside it in
   * index.html): it is a slab down the side of the shop, and most of the tour
   * asks you to press something behind it. The cost is that the wheel listener
   * lives on the CANVAS, so an event over a card nothing can hit is not
   * swallowed, it is delivered to the shop and spent on the zoom — a briefing
   * page longer than its card was a scroller no gesture in the game could
   * reach, which reads as the card having cut its own sentence off.
   *
   * So the words take the mouse only while there is something to scroll, and
   * hand it back the moment there is not. It has to be MEASURED rather than
   * guessed from the length of the copy, because the answer is a fact about
   * three things that each move on their own: the sentence, whether the page has
   * a picture over it, and the height of the window.
   *
   * Called where each of those changes and nowhere else — from `words` on the
   * tick the text is actually written (which is the same tick `paint` writes it,
   * since paint goes through here), and from the resize listener. `scrollHeight`
   * is a layout read and this sits over a live canvas at 10Hz.
   */
  fits() {
    const el = this.el.querySelector('.tt-said');
    // A pixel of slack, or a scroller reporting a hair over its own height
    // takes the mouse for half a line of nothing — which is dead ground over
    // the shop on an ordinary beat.
    el?.classList.toggle('scrolls', el.scrollHeight > el.clientHeight + 1);
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
