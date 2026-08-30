/**
 * THE TUTORIAL — a robot who shows you round, and holds the rest of the game
 * still while it does.
 *
 * ADDING A CARD? READ `docs/tutorial.md` §0 FIRST and nothing else. It is one
 * screen: every field a step and a lesson page may carry, what a predicate is
 * allowed to read, which helpers already exist, where in the rest of the
 * codebase every keybinding and mark colour lives, the console calls that run a
 * card without playing to it, and the traps. This header and the notes below it
 * are the *why*, which is what you want when you are changing the shape rather
 * than adding to it.
 *
 * The shop is deep and every one of its verbs is a *gesture* — a left press
 * takes, a right press puts, a drag builds a run — and none
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
import { pillDrives, mouseGlyph } from './input.js';
import { REPLIED } from '../shared/emotes.js';
import { REACH, isWalkableTile, insideStore, tileAt } from '../shared/build.js';
import { jobBudget, jobsTotal } from '../shared/jobs.js';
import {
  artForPiece, artForGround, artForCrate, artForWorker,
} from './thumb.js';
import { ICONS } from './icons.js';
// The bars' own judgement of themselves — see `gauge`. Imported rather than
// restated, or a card explains a bar that is still green. No cycle: this file
// is imported by `sections.js`, and `hud-meters.js` reaches for nothing but
// `shared/tags.js` and `money.js`.
import { gauge } from './hud-meters.js';
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

/**
 * A KEY, drawn as a key.
 *
 * "The , and . keys swing it a quarter turn" is a sentence with two full stops
 * in it, one of which is a button — and the comma is worse, because a comma in
 * a list of things reads as punctuation whatever it is meant to be. Somebody
 * seven years old cannot parse that line at all, and WASD run together is one
 * word rather than four keys.
 *
 * `[[X]]` in any card's words becomes a key cap: the same one the tooltip wears
 * over a rail button (`#tip .key`), so a key looks like a key everywhere in the
 * HUD. The text is escaped FIRST and the caps put in after, which is the whole
 * of what makes this safe — a card's copy is a string in this file and never
 * markup, and the day one carries an ampersand it must not be able to become a
 * tag.
 */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/**
 * ...and a BLANK LINE is a paragraph, which is the other thing a card's copy
 * cannot say in a string.
 *
 * A hint is one `<p>`, which was right while every hint was one thought. The
 * view card is where that stopped being true — it carries the drag, the two
 * quarter-turn keys, the wheel and WASD, and they are not one thought, they are
 * a list of four things that happen to share a card. Set as one block it reads
 * as a paragraph you give up on halfway through, which on the second card of
 * the game is the tutorial teaching somebody to stop reading it.
 *
 * `\n\n` in the copy rather than a second field, because the split is a fact
 * about the sentence and belongs where the sentence is written. It goes in
 * AFTER the escape, exactly as the key caps do and for the same reason.
 *
 * A SPACER and not `</p><p>`, which is the obvious spelling and is broken: this
 * is written as the `innerHTML` of a `<p>`, and a paragraph inside a paragraph
 * is not a thing the parser will build — what you get depends on the browser
 * and none of the answers is two paragraphs. A block span costs nothing, cannot
 * nest wrongly, and leaves the type styling on the one element it was written
 * for.
 */
const keyed = (s) => esc(s)
  .replace(/\[\[(.+?)\]\]/g, '<kbd class="tt-key">$1</kbd>')
  .replace(/\n{2,}/g, '<span class="tt-gap"></span>');

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
      // ...and WHICH unit it is, for the same reason the position is here: the
      // snapshot says a unit's kind and never which piece it was built from, so
      // a card that drew "a shelf" drew the catalog's plain shelf while the mark
      // in the shop sat on a Pallet Rack, a Produce Table or a Gondola. Two
      // pictures of one thing that disagree is the trap this file's own art note
      // is about — and here the disagreement is with the thing you are stood in
      // front of.
      return at ? { ...s, x: at.x, z: at.z, piece: at.piece, variant: at.variant } : null;
    })
    .filter(Boolean);
};

/**
 * A picture of a unit the tour is pointing at — of THAT unit.
 *
 * `artOf` answers for a kind ("the cheapest freezer"), which is right on the
 * build card, where the thing does not exist yet and the card is sending you to
 * find it on the bar. It is wrong for every card that rings something already
 * standing in the shop: the unit has a piece, the piece has its own art, and a
 * card drawing the generic one is telling you to press a thing it is not showing
 * you. A placement with no `piece` names its own kind (`kindOf`), which is what
 * the fallback is.
 */
function artOfUnit(t, unit) {
  if (!unit) return null;
  const rows = t.ui.catalog?.fixtures ?? [];
  const row = rows.find((f) => f.id === (unit.piece ?? unit.kind));
  return row ? artForPiece(row, unit.kind, unit.variant ?? '') : artOf(t, unit.kind);
}

/**
 * A unit as a target, marked round the UNIT rather than on its tile.
 *
 * A fixture's art is drawn most of a tile up-screen of the cell it stands on —
 * the same fact `pickFixture` exists for — so a frame laid on that cell sits
 * across the foot of the thing it means and rings whatever is standing one
 * square nearer the camera. In an aisle that is not a near miss, it is the
 * neighbour every time, with a card beside it insisting the neighbour is a
 * shelf. `fixture` hands the renderer the id and it cuts the outline from the
 * meshes themselves (`Scene.setTutorTarget` → `markerFor`), which cannot be
 * round the wrong object. A crate and a bare square keep the ground frame:
 * neither has art that stands up off its own cell.
 */
const atUnit = (unit, y) => ({ world: unit, y, fixture: unit?.id ?? null });

/**
 * The nearest crate of stock on the floor — the one the marker should point at.
 *
 * `waste` and not `rubbish`, and it was spelled the second way from the day it
 * was written. The flag on the wire is `waste` (see `deliveries` in `snapshot`,
 * where it rides only when true), so the filter matched nothing and the tour's
 * "go and pick up the box" beat would happily ring a bin bag — with a card
 * beside it about the delivery that has just arrived. Invisible in every shop
 * without a skip, which is every shop the tour has ever run in, because rot
 * only becomes a box if you own one.
 */
function nearestCrate(t) {
  const me = meOf(t);
  const crates = (t.state?.deliveries ?? []).filter((d) => !d.waste && lotSize(d) > 0);
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

  /**
   * A CELL WITH A BOX ON IT IS NOT A BIT OF FLOOR.
   *
   * The card says "click the marked tile, you walk to it", and a tap that
   * lands on a crate is not a walk — `pickPallet` names the box, and a press on
   * a box you are not stood at walks you over and shoulders it. So the marked
   * tile would teach the wrong sentence AND spend the next card, which is the
   * whole-box lift: you would arrive already carrying it and watch a beat about
   * picking up a crate flash past having been completed by the beat before it.
   *
   * It matters most where it is most likely, which is the bay — the pad is both
   * the best walk in the shop and the one place a box is ever standing. The
   * general sweep gets the same test because a stripped shelf, a harvest or an
   * armful put down leaves boxes on ordinary floor.
   */
  const boxes = (t.state?.deliveries ?? []);
  const clear = (c) => !boxes.some((b) => Math.abs(b.x - c.x) < 0.7 && Math.abs(b.z - c.z) < 0.7);

  // The bay first — the cell of it nearest to you, so the walk is the short way
  // in rather than a march to the far corner of a pad you painted wide.
  const bay = [];
  for (let z = 0; z < (L.h ?? 0); z += 1) {
    for (let x = 0; x < (L.w ?? 0); x += 1) {
      if (tileAt(L, x, z) !== T.BAY || !isWalkableTile(L, x, z)) continue;
      if (!clear({ x, z })) continue;
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
      if (!clear({ x, z })) continue;
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
 * How much of the first hire's day is still unspent.
 *
 * Asked of the roster and the catalogue rather than of the panel drawing them,
 * for the reason `jobSig` gives: the shift panel holds a local copy it repaints
 * from, so a card reading the DOM would change its sentence the moment a number
 * on screen moved and before the shop had been told anything.
 *
 * `jobBudget` is the same function the panel and the server use, or this is a
 * second opinion about a cap and the card would offer a press the shop refuses.
 */
function sparePoints(t) {
  const who = (t.state?.roster ?? [])[0];
  if (!who) return 0;
  const kind = (t.ui.catalog?.workers ?? []).find((w) => w.id === who.kind);
  if (!kind) return 0;
  return jobBudget(kind, who.tier) - jobsTotal(who.jobs);
}

/**
 * The shortlist's tab on a fixture menu, and whether it is the one open.
 *
 * By `aria-label` and not by `data-fxtab`, which is an INDEX into whatever
 * groups this fixture happens to have — the shortlist is first on a shelf today
 * and is not on a bed, and a card that named a number would light the seed
 * picker the day somebody adds a group above it. The label is the heading
 * `fixture-menu.js` passes to `group`, so the two can only disagree by somebody
 * renaming the heading, which is a rename the sentence on the card needs anyway.
 *
 * Read out of the DOM rather than off `ui._fxTab` for the same reason `pulseAt`
 * measures rather than computes: what is being asked is "is the thing this card
 * is pointing at on screen", and the panel is the only thing that knows.
 */
const QUICK_TAB = '#panel .tabs .tab[aria-label="Quick pick"]';
const quickTabShut = () => {
  const tab = document.querySelector(QUICK_TAB);
  // No tab strip at all means one group, which IS the shortlist — a menu with
  // nothing to choose between is not a menu you can be on the wrong page of.
  return !!tab && !tab.classList.contains('on');
};

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
 * TURNING THE VIEW, drawn rather than described.
 *
 * It rides on the WALK card — both tours' — rather than having one of its own,
 * and that is the decision worth keeping. Getting about is one thing: where you
 * are and what you can see are the same question asked of your feet and of the
 * camera, and the drag that turns the shop is the very press somebody makes by
 * accident on their way to their first walk. A card of its own was built and
 * thrown away for that reason.
 *
 * It is the only picture in either tour, and the reason is the one thing about
 * the walk card that is not standing in the shop: the ringed tile is the walk,
 * and a *gesture* has nowhere to be ringed. Every other card points at a thing
 * and wants no picture — a diagram of a shelf you are looking at is a second
 * shelf to find — where this teaches a press, and a sentence about holding a
 * button and dragging is one you have to act out before it means anything. The
 * drawing acts it out.
 *
 * The mouse is `mouseGlyph`, which is the pill's own glyph and not a second
 * drawing of one. That is the whole idea: the pill has been putting that exact
 * mouse with that exact button filled in front of you since the first time you
 * stood at a crate, so the card teaches the gesture in the vocabulary the game
 * has already been speaking. A hand-drawn mouse here would be a picture of a
 * mouse; this is a picture of the thing the HUD means.
 *
 * It RIDES the arc — `animateMotion` along the same path the arrow is drawn
 * from, out and back — which is the half a still picture cannot say. A mouse
 * beside a curve says "there is a curve"; a mouse sliding along one says drag.
 * Declarative SVG rather than a frame loop, for the reason `FACE`'s blink is a
 * CSS animation: the card is rebuilt and thrown away on every step, and an
 * animation with nothing to clean up cannot leak one.
 *
 * The building in the middle is drawn here rather than taken from the catalog,
 * which is this file's own rule about art (`artOf`) broken on purpose and worth
 * saying why: there is no `fixtures` row for "your shop", the thing being
 * turned is the whole world rather than a piece in it, and at this size it is
 * three rectangles. The colours are still the hires' — `#d7dfe8`, `#c3ccdb`,
 * `#83909f` — so it belongs to the same set of boxes everything else does.
 *
 * The touch half is the same picture with the same arc, said in the other
 * grammar: two fingertips on it, rocking about the middle. `,`/`.` and the
 * wheel are in the small print rather than in the picture — four things in a
 * 168x100 well is a diagram nobody reads, and the keys are the one part a
 * sentence says perfectly well.
 */
const VIEW_SHOP = '<g class="tt-ink">'
  + '<rect x="64" y="46" width="42" height="32" fill="#d7dfe8"/>'
  + '<rect x="64" y="46" width="42" height="9" fill="#c3ccdb"/>'
  + '<rect x="79" y="62" width="12" height="16" fill="#83909f"/>'
  + '</g>';

/**
 * ...and the same building on its own, for the card that opens the tour.
 *
 * The welcome card is the one beat with no target: nothing is ringed, nothing is
 * pressed, and what it is about is the whole place rather than anything in it —
 * so the picture is the shop, which is exactly what `VIEW_SHOP` already draws.
 * Reused rather than redrawn: a second little building would be two pictures of
 * one thing, which is this file's own rule, and the sentence beside it is
 * "welcome to your shop".
 *
 * The view box is cropped to the building alone, since the arc it usually sits
 * inside is a gesture this card does not teach.
 */
// `tt-shopfront` takes the line DOWN with the zoom, and it is a class rather
// than an inline style because `.tt-ink`'s own rule would beat anything
// inherited from the svg. Two units is right in a 168-wide diagram of a gesture
// and is a quarter of an inch of black once the same building fills the well on
// its own — a shop drawn as an outline rather than as a thing.
const helloArt = () => '<svg class="tt-diagram tt-shopfront" viewBox="58 40 54 44"'
  + ' aria-hidden="true">' + VIEW_SHOP + '</svg>';

// The orbit, and the two heads that say it goes both ways. A half-ellipse, so
// the tangent at each end is straight down and a plain downward triangle is the
// arrowhead — no rotation to keep in step with the path.
const VIEW_ARC = '<path class="tt-go" id="tt-orbit" d="M30 62 A 55 26 0 0 1 140 62"/>'
  + '<path class="tt-head" d="M30 69 L25.5 58 H34.5 Z"/>'
  + '<path class="tt-head" d="M140 69 L135.5 58 H144.5 Z"/>';

const VIEW_SWEEP = 'dur="3.4s" repeatCount="indefinite" keyPoints="0;1;0"'
  + ' keyTimes="0;0.5;1" calcMode="spline" keySplines=".4 0 .2 1;.4 0 .2 1"';

/**
 * Has this person asked not to be moved?
 *
 * Asked here rather than in a media query, because the sweep is SMIL: a CSS
 * rule cannot switch off an `animateMotion`, and `display: none` on one is not
 * specified to stop it — so the art is built without it instead. Read at draw
 * time rather than once at module load, or somebody who turns the setting on
 * mid-session goes on being swept until they reload.
 *
 * The still frame is not an empty one: the mouse parks at the top of the arc,
 * the fingers sit level on it, and the arrowheads at both ends are what say
 * which way it goes — which they were doing for the moving version too.
 */
const stillArt = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// The apex of `VIEW_ARC` — centre 85, ry 26 off 62 — which is where the rider
// parks when it is not allowed to travel.
const VIEW_APEX = 'transform="translate(85 36)"';

const dragArt = () => {
  const still = stillArt();
  return '<svg class="tt-diagram" viewBox="0 0 168 100" aria-hidden="true">'
    + VIEW_SHOP + VIEW_ARC
    // Offset up the page rather than centred on the path, or the arc is drawn
    // through the middle of the mouse and neither shape reads.
    + `<g${still ? ` ${VIEW_APEX}` : ''}>`
    + mouseGlyph(true, 'x="-10.5" y="-32" width="21" height="30"')
    + (still ? '' : `<animateMotion ${VIEW_SWEEP}><mpath href="#tt-orbit"/></animateMotion>`)
    + '</g></svg>';
};

const twistArt = () => '<svg class="tt-diagram" viewBox="0 0 168 100" aria-hidden="true">'
  + VIEW_SHOP + VIEW_ARC
  // Both fingers in one group turned about the middle of the arc, which is what
  // a twist is: they keep their distance from each other and from the shop.
  + '<g><circle cx="50" cy="30" r="9" fill="#3b424e"/>'
  + '<circle cx="120" cy="30" r="9" fill="#3b424e"/>'
  + (stillArt() ? '' : '<animateTransform attributeName="transform" type="rotate"'
    + ' values="-16 85 62; 16 85 62; -16 85 62" dur="3.4s" repeatCount="indefinite"'
    + ' calcMode="spline" keyTimes="0;0.5;1" keySplines=".4 0 .2 1;.4 0 .2 1"/>')
  + '</g></svg>';

/** Which of the two the walk card shows, asked at draw time like every `say`. */
const viewArt = () => (pillDrives() ? twistArt() : dragArt());

/**
 * WHERE THE CAMERA STANDS, for the two cards that are worth shooting.
 *
 * The tour has always been able to move the view — `look` puts the centre on
 * whatever a card is pointing at — and it has never been able to point it. The
 * two are different jobs: a centre says which bit of the shop, and the angles
 * say what it looks like, and the opening card is entirely about the second.
 * A new shop opens on the ordinary playing pose, which is a corner of a building
 * seen from above; the card under it says hello. What that reads as is a menu
 * over a screenshot.
 *
 * So `shot` is a step's own pose, eased into from wherever the view happens to
 * be (`Scene.aimView`) — never cut, because a cut is a different shop and a
 * swing is the same one looked at from somewhere else. Two cards use it and the
 * pair is the whole design:
 *
 * - **hello** stands the camera dead south of the building at almost eye level,
 *   so what you are looking at is a shopfront with your shopkeeper in the door
 *   of it, facing you. It is the establishing shot, and it is the one frame in
 *   the game that is a picture of a shop rather than a plan of one.
 * - **walk** hands the view back: the playing pitch, on the corner the card's
 *   own ringed tile is on. Which corner is worked out rather than written down,
 *   because the tile is `spotToWalk`'s answer and that is the bay, the drop-off
 *   or a bit of floor depending on the shop — so a hard-coded corner would put
 *   the building between the camera and the thing the card is asking you to
 *   walk to, in exactly the shops where the walk is longest.
 *
 * Nothing else in either tour has one, and that is deliberate rather than
 * unfinished: every card after these is asking you to press something, and a
 * camera that moved on its own while you were reaching for a shelf is the fight
 * `nudge` is forbidden from picking with the build bar. Once the view is handed
 * back it stays handed back.
 */
/**
 * The pause between your feet stopping and the hire's arm going up.
 *
 * Long enough to read as an answer rather than as the same event — two bodies
 * arriving and a wave on the same frame is one thing happening, and what it is
 * meant to be is somebody noticing you.
 */
const HELLO_WAVE_MS = 450;

/**
 * How often the tour says again that the crew are to stand still.
 *
 * See `holdCrew`. Short enough that a hire never gets a job loop's worth of
 * work done after a restart, long enough to be nothing on the wire.
 */
const CREW_HOLD_MS = 3000;

/** ...and how long it waits for a hire who is never going to make it. */
const HELLO_GIVE_UP_MS = 4000;

/**
 * The beat between the thing turning up and the mark landing on it.
 *
 * A step ARMS what it points at — `arm` opens the crew strip, the supplier, a
 * fixture menu — so the panel and the ring arrived on the same frame, and two
 * things appearing together read as ONE thing appearing. The eye has nowhere to
 * look first, which is exactly what the mark is for: saying which of the twenty
 * rows that just turned up is the one. It is the same argument `HELLO_WAVE_MS`
 * makes about a wave — long enough to read as an answer to the panel rather
 * than as part of it.
 *
 * Measured from when the target was first FOUND rather than from when the card
 * opened, because most of the tour points at something that was already on
 * screen, and a card whose target never moved would otherwise spend the same
 * beat pointing at nothing. See `markReady`.
 */
const MARK_WAIT_MS = 420;

const FRONT_PITCH = 11 * (Math.PI / 180);

// A quarter turn back off the home corner, which is the one yaw that puts the
// camera square to a wall rather than on a diagonal — see `aimCamera`: the base
// offset is (+x, +z), so -45° swings it onto +z alone, which is the front.
const FRONT_YAW = -Math.PI / 4;

const frontShot = (t) => {
  const L = t.scene?.storeLayout;
  const door = L?.door;
  if (!door) return null;
  // The forecourt rather than the doorway, and the two tiles are load-bearing:
  // the cutaway fades whatever stands between the camera and the middle of the
  // VIEW (`wallHides`), so a centre one tile inside the building would take the
  // shopfront away — on the one card whose whole subject is the shopfront. Out
  // here the wall is behind the centre rather than in front of it, and the shop
  // sits in the top of the frame with its own forecourt under it.
  //
  // `hold` because this is the one shot with actors walking into it — see the
  // note in `look`.
  return { yaw: FRONT_YAW, pitch: FRONT_PITCH, x: door.x + 0.5, z: door.z + 2, hold: true };
};

const walkShot = (t) => {
  const spot = t.step?.spot ?? null;
  const s = t.scene?.storeLayout?.store;
  if (!spot || !s) return null;
  const cx = s.x + s.w / 2;
  const cz = s.z + s.h / 2;
  // Which corner stands the camera on the same side of the shop as the tile?
  // The base offset is (1, 1) turned by the yaw, so this is that vector against
  // the one pointing at the tile — biggest wins, which is "nearest to it".
  let best = 0;
  let bestDot = -Infinity;
  for (let q = 0; q < 4; q += 1) {
    const a = q * (Math.PI / 2);
    const dx = Math.cos(a) + Math.sin(a);
    const dz = Math.cos(a) - Math.sin(a);
    const d = dx * (spot.x - cx) + dz * (spot.z - cz);
    if (d > bestDot) { bestDot = d; best = a; }
  }
  /**
   * ...and it frames the pair of you rather than the tile.
   *
   * Centring the marked tile is the obvious thing and it fights the card: the
   * next press is a tap on that tile, `walkTo` recentres on the way past
   * (which is right — going somewhere is how you reclaim the view), so the
   * camera sets off toward the bay, gets a third of the way, and is hauled back
   * to a body standing where it started. What that reads as is the camera
   * overshooting and correcting, on the one card that has just told you the
   * drag is yours.
   *
   * The midpoint has neither problem: the tile is on screen, you are on screen,
   * and the recentre when you tap it is half a move rather than a reversal.
   */
  const me = meOf(t);
  const mid = me
    ? { x: (me.x + spot.x) / 2, z: (me.z + spot.z) / 2 }
    : spot;
  return { yaw: best, pitch: t.scene?.homePitch, x: mid.x, z: mid.z };
};

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
 * ...and the CAMERA is the test of that rule rather than an exception to it. It
 * had a card of its own for about an hour and should not have: getting about is
 * one decision — where you are and what you can see are the same question asked
 * of your feet and of the view — so it is the walk card's small print, with the
 * gesture DRAWN on the card rather than described. See `dragArt`.
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
    // The establishing shot — see `frontShot`. The one card in the tour that is
    // a picture of a shop rather than a plan of one.
    shot: frontShot,
    /**
     * ...and the two of you WALK INTO IT while it swings.
     *
     * A camera move over an empty forecourt is a screensaver. What makes it an
     * opening rather than a title card is that there are two of you in it and
     * you arrive during it: the shot takes about two and a half seconds
     * (`TOUR_EASE`) and the walk out of the door takes about one, so the swing
     * lands on the pair of you already standing there.
     *
     * They face the camera for free, and that is the whole reason the target is
     * *south* of the door rather than a spot with a facing attached: everything
     * in this game faces the way it is travelling (`followPath`), the camera is
     * due south of the building, so walking out of the front door IS turning to
     * face it. No pose, no facing field, nothing to hold them in it afterwards.
     *
     * In `nudge` with a one-way latch rather than in `arm`, for the reason the
     * shot is asked for every frame: `arm` runs once on open and the layout has
     * often not landed by then, and a cue that fired into a shop with no door
     * in it yet would simply not happen.
     *
     * `walk-to` is the ordinary tap, sent straight down the wire rather than
     * through main.js's own `walkTo` — that one recentres the camera, which is
     * right for a tap you made and would throw this shot away on the frame it
     * started. `crew-pose` is the crew's half, and it exists because the crew
     * have downed tools for the length of the tour (`crew-idle`) and a hire
     * with no job loop has no way to be anywhere.
     */
    nudge(t) {
      const door = t.scene?.storeLayout?.door;
      if (!door) return;
      /**
       * ONE EITHER SIDE OF THE DOORWAY, rather than one in it and one off on
       * the grass.
       *
       * The mark used to be the door's own column, which put YOU dead centre in
       * front of it and the hire out on the left with the shot's whole middle
       * spent on your back. A tile each way is the same two bodies arranged
       * around the thing the card is introducing: the shopfront is between
       * them, shoulder to shoulder in the doorway rather than one of them out
       * on the grass, and the camera centre is the half-tile between the two of
       * them — `focusOn` takes a float.
       */
      const mark = { x: door.x + 1, z: door.z + 2 };
      if (!this.cued) {
        this.cued = true;
        t.net?.send('walk-to', mark);
        // The far side of the doorway. `crewPose` fans a bigger crew out round
        // the cell on its own; this is which cell, and `facing` 0 is south —
        // `atan2(dx, dz)` of (0, 1) — which is the camera. It has to be said,
        // because the last leg of that walk is sideways.
        t.net?.send('crew-pose', { x: door.x, z: door.z + 2, facing: 0 });
        return;
      }
      /**
       * ...and then they say hello, which is the beat that makes it a greeting
       * rather than two robots standing on a pavement.
       *
       * After BOTH of you have stopped rather than on a stopwatch from the cue:
       * the walk is however long your shop's counter is from its door, so a
       * fixed delay waves at somebody still crossing the floor in a big shop
       * and at an empty forecourt in a small one. The hire is asked about
       * separately because they are not walking your route — theirs is a cell
       * over and a step longer, so waving on your arrival is an arm going up on
       * a body that is still moving, which reads as a stumble rather than as a
       * greeting.
       *
       * Arrival is asked as "are they standing on the mark" rather than "have
       * they stopped": the snapshot carries where everybody is and not what
       * they are doing, and a body that stopped for any other reason is not one
       * that got here.
       *
       * The extra beat after that is a pause for breath — an arm that goes up
       * on the frame their feet stop reads as the two being one event.
       */
      if (this.waved) return;
      const me = meOf(t);
      if (!me || dist(me, mark) > 0.9) return;
      this.landed ??= performance.now();
      const waited = performance.now() - this.landed;
      /**
       * ...and "arrived" is STOPPED as well as near, which the second half of
       * this is entirely about.
       *
       * A radius alone fires while they are still walking — they come out of a
       * door two tiles from the mark, so a hire is inside any honest radius for
       * most of their journey, and what you watch is an arm going up on a body
       * still crossing the forecourt. The snapshot says where everybody is and
       * never what they are doing, so stillness is measured rather than asked:
       * two frames in the same place, at 10Hz, against a walk that covers 0.42
       * of a tile between them.
       *
       * The radius stays, and it is what keeps this from firing before they set
       * off at all: between the cue and the server planning the route they are
       * standing perfectly still behind the till, which is stopped and is not
       * arrived. The whole forecourt rather than one cell, because `crewPose`
       * fans a crew of several round the mark.
       */
      const crew = (t.state?.players ?? []).filter((p) => p.staff);
      const seen = this.seen ?? {};
      const still = crew.every((s) => {
        const was = seen[s.id];
        return was && Math.abs(s.x - was.x) < 0.02 && Math.abs(s.z - was.z) < 0.02;
      });
      this.seen = Object.fromEntries(crew.map((s) => [s.id, { x: s.x, z: s.z }]));
      const there = still && crew.every((s) => dist(s, mark) <= 3);
      // ...and it gives up waiting, because a hire who cannot get out there —
      // walled in, or a shop whose door is somewhere else entirely — must not
      // be the reason the greeting never happens. The card still works with
      // nobody in it; it is just quieter.
      if (!there && waited < HELLO_GIVE_UP_MS) return;
      this.ready ??= performance.now();
      if (performance.now() - this.ready < HELLO_WAVE_MS) return;
      this.waved = true;
      t.net?.send('crew-pose', { emote: REPLIED });
    },
    art: helloArt,
    say: 'Welcome to your shop. Stick with me and I\'ll show you round.',
    hint: 'We\'ll fill the shelves, say hello to the robot who works here, and '
      + 'open the doors. Had enough? Skip is bottom right, on every card.',
    big: true,
  },

  {
    id: 'walk',
    kicker: 'Getting about',
    say: (t) => perInput(
      t.step?.spot ? 'Click the marked tile. You walk to it.' : 'Click a bit of floor. You walk to it.',
      t.step?.spot ? 'Tap the marked tile. You walk to it.' : 'Tap a bit of floor. You walk to it.',
    ),
    // ...AND THE OTHER HALF OF GETTING ABOUT, which is the view.
    //
    // A press that MOVED is never a walk — the drag is the camera — so the
    // first thing anybody does by accident is turn the shop rather than walk
    // across it, and until it is said that reads as a click that did nothing.
    // It is the picture that says it (`viewArt`, on this card): a sentence
    // about holding a button and dragging is a sentence you have to act out to
    // understand, and the drawing acts it out for you. The words are left with
    // the two the drawing cannot make — the keys and the wheel.
    art: viewArt,
    hint: viewHint,
    // Ringed on the floor rather than "somewhere over there". The tile is
    // chosen once and held, or the mark walks away from you as you approach it.
    // ...and the view is handed back here: the playing pitch, on whichever
    // corner the ringed tile is on. See `walkShot`.
    shot: walkShot,
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
     * So the order follows what the game actually does: the press on a crate
     * across the shop is the whole-box lift, which is the one press the walk
     * produces.
     */
    /**
     * ...AND THE CARD BEFORE THIS ONE WALKED YOU TO IT.
     *
     * `spotToWalk` sends the walk beat at the crate, so by here you are usually
     * stood right beside the thing — and "you walk over and pick it up" said to
     * somebody already there is the tour describing a journey they can watch
     * themselves not make. It is `atIt` rather than a flat rewrite because the
     * walk is still what happens if they wandered off, and a card that promised
     * a press on the spot and then marched them across the yard would be the
     * same bug pointing the other way.
     */
    say: (t) => {
      const c = nearestCrate(t);
      // WAITING. Nothing to press, so the card stops giving instructions and
      // says what is happening and where to watch it — the first draft here was
      // "Van is on its way. Crates get left on the pad round the back", which is
      // two facts and no address, on the one beat where the player is sitting
      // still with nothing to do.
      if (!c) return 'Waiting for your delivery.';
      if (!atIt(t, c)) {
        return perInput('Click the crate. You walk over and pick the whole box up.',
          'Tap the crate. You walk over and pick the whole box up.');
      }
      return perInput('Click the crate. You pick the whole box up.',
        'Tap the crate. You pick the whole box up.');
    },
    // True wherever you are standing, which is what keeps it from arguing with
    // the sentence above on the frame you step away.
    hint: (t) => (nearestCrate(t)
      ? perInput(
        'Right next to it, it happens there and then. Click something further '
          + 'off and you walk over first. A box holds far more than your arms.',
        'Right next to it, it happens there and then. Tap something further '
          + 'off and you walk over first. A box holds far more than your arms.',
      )
      /**
       * WAITING, AND IT NAMES NO KEY.
       *
       * This said "Press [[B]] for the Supplier to see where your van is", and
       * on the one beat with nothing to do it handed out homework: a key to
       * learn, a panel to open, and a list to read, for an answer the button
       * itself is already drawing. The well is a live copy of that button (see
       * `at` below), so the honest card is a caption for the picture already in
       * front of them — the gold count and the ring that wraps it — and no
       * press at all.
       *
       * `perInput` would say the same words twice: nothing here is a click, a
       * tap or a key.
       */
      : 'The ring round the Supplier button fills as the van gets nearer.'),
    /**
     * ...and while it is waiting, the well shows the two things the sentence
     * names — the button to watch the order on, and the pad the crates land on.
     *
     * `mock` rather than `art`, which is the mechanism rather than a
     * preference: `art` is painted once when the step opens (see `paint`), so a
     * picture chosen on "is there a crate yet" would still be the pad twenty
     * seconds after the van arrived. `mockAt` is called from `place` on every
     * snapshot, so it is the one half of the card's picture that can walk with
     * the sentence — which is exactly what a two-phase beat needs.
     */
    at: (t) => (nearestCrate(t)
      ? { world: nearestCrate(t), y: CRATE_Y }
      : { mock: '[data-rail="stock"]' }),
    // The box itself, drawn from the same numbers and colours the one on the
    // floor is built from (`artForCrate`). The thing IS marked in the shop, so
    // this is the one case the header's "a second picture would be a diagram of
    // something you are looking at" argues against — and it is wrong about a
    // crate: the marked one is a box on a pad at the far end of a green frame,
    // and what the card is teaching is which of the things down there is a box.
    // Wrapped, and it has to be: `paint` calls a step's `art` as `s.art(this)`,
    // so the bare function is handed the tour where `waste` goes — every truthy
    // value there is the drab colourway, and what the card drew was a crate of
    // rubbish over a sentence about the delivery you are being sent to fetch.
    art: () => artForCrate(),
    // ...and the pad the box will be standing on, drawn from the brush's own
    // swatch. Under the words rather than in the well, because the well is the
    // crate — this is a footnote saying WHERE, the way the arrow key is a
    // footnote saying which.
    // ...and it says a different thing on each side of the wait, for the reason
    // `at` and `say` do. While the van is out the list is about the button in
    // the well — what the gold number counts — and once the box is on the pad
    // that row has answered itself and goes, leaving the one line that is still
    // true: where deliveries land.
    legend: (t) => (nearestCrate(t) ? '' : iconRow(ICONS.supplier,
      'The gold number is how many are coming.'))
      + iconRow(ICONS.crate, 'Every delivery lands on the pad round the back.'),
    arm(t) { t.ui.toggleBuild?.(false, { quiet: true }); t.ui.showBar(null); },
    // Nobody's fault and nothing to press. Without this the card reads as an
    // instruction you are failing, and the stranded-timer offers to skip the
    // one beat the whole tour is building up to.
    waiting(t) { return !nearestCrate(t) && !meOf(t)?.haul; },
    done(t) { return !!meOf(t)?.haul; },
  },

  {
    id: 'pour',
    kicker: 'Stock',
    say: () => perInput('RIGHT-click a shelf to tip the box in.',
      'Tap a shelf, then press Stock it to tip the box in.'),
    /**
     * ...AND WHAT THE TWO ARROWS MEAN, which nothing anywhere said.
     *
     * A solid chevron and a ghosted one are `stock` and `stockOpen` — the same
     * green on purpose (see `MARKER_LOOK`: they are one answer with a
     * consequence attached, so the geometry carries the difference rather than a
     * second colour). What the consequence IS was never written down for the
     * player, so a shop full of arrows in two weights reads as some of them
     * having gone out. Solid: this shelf has some already, so the press tops
     * that pile up. Ghosted: it has none, so the press starts a new pile —
     * which is the decision, because a board is the thing there are only so
     * many of.
     */
    // ...and the two arrows are DRAWN rather than described — see `arrowArt`.
    // What is left in the words is the half a picture cannot make: which button,
    // and what happens when the shelf runs out of room.
    hint: () => perInput(
      'Left takes, right puts. Green arrows float over every shelf that will '
        + 'take what you are holding. It stops when the shelf is full and the '
        + 'rest stays on your shoulder.',
      'Stock it pours in everything that fits. Green arrows float over every '
        + 'shelf that will take it. It stops when the shelf is full and the '
        + 'rest stays on your shoulder.',
    ),
    art: (t) => artOfUnit(t, anyShelf(t)),
    // ...and the key to the two arrows, UNDER the words rather than instead of
    // the picture. The well is the shelf, which is what the card is about; this
    // is a footnote with pictures in it, and a footnote does not take the
    // portrait's place. Two rows, because there are two arrows.
    legend: arrowArt,
    at: (t) => atUnit(anyShelf(t), SHELF_Y),
    // A latch, because "no box on your shoulder" is also true of somebody who
    // never had one — a crate shelved by hand, or a beat reached by pressing a
    // dot on the card.
    start(t) { this.lifted = !!meOf(t)?.haul; },
    nudge(t) { if (meOf(t)?.haul) this.lifted = true; },
    done(t) { return this.lifted && !meOf(t)?.haul; },
    skipWhen(t) { return !meOf(t)?.haul && !nearestCrate(t); },
  },

  {
    id: 'menu',
    kicker: 'Shelves',
    say: 'Press and HOLD on the marked shelf.',
    /**
     * A hold is the other half of every press in the game and nothing on screen
     * says so. A player who never finds it never prices anything, never sets a
     * shelf aside and never sells a fixture back.
     *
     * NAME WHAT IS INSIDE. This said "holding opens what it can do", which is
     * a description of a menu rather than a reason to open one — and it spent
     * its last clause on where else the gesture works, which is a fact for
     * later and not an answer to "why am I holding this button". The contrast
     * is the useful half: a quick press already does something else, so the
     * card has to say which press is which.
     */
    hint: 'Inside: the price, what it is kept for, moving it, selling it back.',
    // The two presses DRAWN rather than contrasted in prose — see `pressRow`.
    legend: () => pressRow(false, perInput('A quick click takes one thing off it.',
      'A quick tap lists what it can do.'))
      + pressRow(true, perInput('Holding opens the shelf itself.',
        'Holding opens the shelf itself.')),
    art: (t) => artOfUnit(t, anyShelf(t)),
    at: (t) => atUnit(anyShelf(t), SHELF_Y),
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
    say: (t) => {
      if (t.ui.openPanel !== 'fixture') return 'Press and hold the shelf again to bring its menu back.';
      return quickTabShut() ? 'Open the "Quick pick" tab on that menu.'
        : 'Under "Quick pick", choose what this shelf is for.';
    },
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
    //
    // ...AND THE MARK IS THE LIST, NOT THE MENU. It was the whole of `#panel`,
    // which is a frame drawn round a panel that fills a third of the screen and
    // has a header, a board row with four buttons on it, five tabs and a foot of
    // verbs in it — every one of them a press this card is not asking for. A
    // mark round everything says the same as no mark at all, which is the
    // argument `pulseAt` already makes about a lit panel with forty rows in it.
    // `.pnl-mid` is the shortlist and nothing else: the one thing on the menu
    // this card is about.
    //
    // The third phase is the tab, and it is not hypothetical — `_fxTab` is
    // remembered per kind (`ui._fxTab`), so a shelf opened on Settings a minute
    // ago comes back on Settings, and a mark round `.pnl-mid` would then be a
    // frame round the wrong list under a sentence naming a heading that is not
    // on screen. Pointed at the tab instead, with the sentence saying so.
    art: (t) => artOfUnit(t, anyShelf(t)),
    at: (t) => {
      if (t.ui.openPanel !== 'fixture') return atUnit(anyShelf(t), SHELF_Y);
      return quickTabShut() ? { el: QUICK_TAB, pad: 6 } : { el: '#panel .pnl-mid', pad: 6 };
    },
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
    /**
     * THE NAME ON SCREEN AND THE KEY, which "open the crew strip" was neither.
     *
     * There is no "crew strip" anywhere in the game — the section is called
     * **Crew** and it is on [[H]] (`client/sections.js`). A card that invents a
     * name for a thing sends somebody hunting for a word that is not there, and
     * the hint under it was three lines of what a hire IS, which is not the
     * question anybody has while looking for a button.
     */
    say: (t) => (t.ui.bar === 'staff'
      ? perInput('Click your robot to open them up.', 'Tap your robot to open them up.')
      : perInput('Press [[H]] to open your Crew.', 'Press Crew on the right.')),
    hint: (t) => (t.ui.bar === 'staff'
      ? 'The shop came with one. They serve, fill shelves and work the beds.'
      : 'Everyone who works here is a robot you lease by the day.'),
    // ...and the card shows the button it is naming, which is the half a
    // sentence cannot carry to somebody who has never seen the HUD — see
    // `mockOf`. The mock walks with the phase, because the sentence does.
    at: (t) => {
      if (t.ui.bar !== 'staff') return { el: '[data-rail="staff"]', mock: '[data-rail="staff"]' };
      const who = (t.state?.roster ?? [])[0];
      const sel = who ? `[data-entry="hire:${who.id}"]` : null;
      return { el: sel, mock: sel, pad: 6 };
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
    /**
     * ADD, RATHER THAN TAKE AWAY.
     *
     * The first move this card could offer used to be a subtraction, and not by
     * choice: the Shop Hand's authored list comes to exactly its own cap, so
     * every `+` in the panel is dead on the frame it opens and the only press
     * available is a `−`. "Spend a point" is what everybody expects of a shift
     * panel and it was the one thing it could not do — so the shop now comes
     * with a hire holding a spare (`starterHire`, server/worlds.js) and this
     * says so.
     *
     * Both sentences are kept, because the spare is the STARTING shop's and
     * this card is also reached by somebody replaying the tour in a shop where
     * the point has long since been spent. `spare` asks the roster rather than
     * assuming.
     */
    say: (t) => {
      if (t.ui.openPanel === 'worker') {
        return sparePoints(t) > 0
          ? 'They have a point spare. Add it to a job you want more of.'
          : 'Move a point around. Take one off a job they will not be doing.';
      }
      // The section's own name and key, for the `hire` beat's reason.
      if (t.ui.bar !== 'staff') return perInput('Press [[H]] for your Crew again.', 'Press Crew on the right again.');
      return perInput('Click your robot to open them up.',
        'Tap your robot to open them up.');
    },
    hint: (t) => (t.ui.openPanel === 'worker'
      ? 'Press + on a job to give it more of their day. The total is capped, so '
        + 'one job goes up and another comes down.'
      : 'You choose what they spend the day on — the till, stock, sweeping, the beds.'),
    // The whole list, never the Serve `+`. That button goes dead the moment the
    // shift is full — which on a fresh clerk it usually already is — so a hole
    // cut round it is a hole round a button that cannot be pressed, with the
    // `−` that would make room for it out in the blackout. The lesson was never
    // "press +", it is "these numbers come out of one another".
    at: (t) => {
      // The mark is the whole list and the PICTURE is one row of it, which is
      // the split `pulseAt` already makes: the list is where the work is, and a
      // row is what a row looks like. `:not(.owned)` is the first row with a
      // number rather than a dot — a picture of a directive set to nothing is a
      // picture of the one row that cannot be stepped down.
      if (t.ui.openPanel === 'worker') return { el: '.wk-jobs', pad: 8, mock: '.wk-jobs .wk-job:not(.owned)' };
      if (t.ui.bar !== 'staff') return { el: '[data-rail="staff"]', mock: '[data-rail="staff"]' };
      const who = (t.state?.roster ?? [])[0];
      const sel = who ? `[data-entry="hire:${who.id}"]` : null;
      return { el: sel, mock: sel, pad: 6 };
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
      // The three things the ghost is telling you are a LIST — see `legend`
      // below. What is left in the words is the one that is not a colour.
      return 'It turns its back to a wall on its own.';
    },
    /**
     * WHAT THE GHOST IS SAYING, one line each.
     *
     * This was a paragraph — "[[R]] turns it before you place it, green means
     * it fits, amber means it fits but will block something" — three separate
     * facts about a picture the player is looking at right now, in a shape that
     * makes you match a word to a colour from memory. Two of the three ARE
     * colours, so they are drawn (`swatchRow`), and the gold square nothing
     * anywhere explains gets a line of its own: it is the side people have to
     * stand on to use the thing, which is the single most useful mark on screen
     * while you are deciding where a shelf goes.
     *
     * The wheel is deliberately absent, and that is a fix rather than a saving:
     * it turns what is in your HANDS (`ui.holding`), and off the bar it goes on
     * zooming. The card used to say the wheel turned an armed tile, which is a
     * press that does something else — the green-ghost bug in a sentence.
     */
    legend: (t) => {
      if (t.ui.toolId?.() !== cheapestFreezer(t)?.id) return null;
      return iconRow(ICONS.rotate, perInput('[[R]] turns it before you place it.',
        'The round turn button beside the bar turns it.'))
        + swatchRow('#ffd66b', 'The gold square is where people stand to use it.')
        + swatchRow('#7cc46a', 'Green: it fits here.')
        + swatchRow('#e0a53c', 'Amber: it fits, but it blocks something. Still allowed.');
    },
    // The piece you are being sent to find, drawn from its own catalog row —
    // the same picture the palette tile wears, which is the half of "pick the
    // Cooler out of the Shop tab" that a name cannot carry.
    art: (t) => artOf(t, 'freezer'),
    // The hammer while the mode is off — the one phase of this card whose subject
    // is a BUTTON rather than the piece. The well hands itself back to the
    // chiller above the moment the bar is up, which is `mockAt` doing what
    // `paint`'s note says a picture may not do, for the reason given there.
    at: (t) => {
      if (t.ui.bar !== 'build') return { el: '[data-rail="build"]', mock: '[data-rail="build"]' };
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
      // The section's own name and key, for the `hire` beat's reason.
      : perInput('Press [[B]] to open the Supplier.', 'Press Supplier on the right.')),
    // "grown in the beds out the side" was here for a long time and stopped
    // being true when the farm came indoors (docs/vats.md): there are no beds,
    // there is no side, and a new shop has neither — so the one sentence naming
    // three sources named a place that does not exist.
    hint: (t) => (inSupplier(t)
      ? 'It turns up on the van at the pad round the back, same as the first one.'
      : 'This is where you buy stock in. Later you can grow it or make it too.'),
    // The hole is the whole panel, because choosing WHAT to buy is the half of
    // this step that is yours — but a lit panel cannot say which press ends it,
    // and forty rows of `×6` is exactly the list where that matters. So the
    // first row that can actually be bought gets the small mark: `.owned` is
    // what a row wears when it is dimmed for having nowhere to go or costing
    // more than the till holds, and pulsing one of those is teaching a press
    // the shop refuses. The drill-down's own `×6` is in the same selector,
    // since one press into an item is still being in the supplier.
    // ...and the picture is the ROW the pulse is on, off the same selector — a
    // supplier row is a thing nobody has seen before (a name, a price, a stock
    // count and a cart), and "buy a case of something cheap" is an instruction
    // to press one part of it. Mocked rather than pulsed alone, because the
    // pulse says WHICH and the picture says WHAT.
    at: (t) => (inSupplier(t)
      ? {
        el: '#panel',
        mock: '#panel .sec-row:not(.owned)',
        pulse: '#panel .sec-row:not(.owned) [data-btn-tag="buy"], #panel [data-act="buy"]',
      }
      : { el: '[data-rail="stock"]', mock: '[data-rail="stock"]' }),
    /**
     * ...and the chiller's tool goes with the card that wanted it.
     *
     * The beat before this one ends the moment a freezer is stood down, which
     * leaves the build palette across the bottom of the screen with the chiller
     * still armed — so the next thing the card asks for is a press on the rail,
     * over a mode where every tap on the floor buys another freezer. Nothing
     * warns you, because arming a tool and keeping it armed is exactly what
     * build mode is for.
     *
     * `toggleBuild(false)` and not `showBar(null)`, which is the same
     * distinction the bar's own close button makes: this leaves the MODE as well
     * as the palette, and it is what sets `toolOff` — putting the chiller down
     * is the half of this that matters.
     */
    arm(t) { t.ui.toggleBuild?.(false); },
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
    // Drawn rather than cloned, which is the one control on the HUD that cannot
    // be the second — see `mockOf`. It is the shut side, because that is the
    // side it is on while this card is up.
    at: () => ({ el: '#sign', pad: 8, mock: 'sign' }),
    // ...and the supplier goes with the card that wanted it. The beat before
    // this one ends the moment an order is placed, which leaves a panel across
    // half the screen over a card now pointing at the shopfront — and closing
    // it is the one press in the tour nobody would learn anything from making.
    // `arm` rather than a side effect in the other card's predicate: the panel
    // belongs to whoever is on screen, and a step that tidied up after itself
    // would be the only one that did.
    arm(t) { t.ui.closePanel?.(); },
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
 * WAVING HAS A MOMENT NOW, and it is not in this array.
 *
 * A card about emotes was parked here for a long time, written and not running,
 * because it had nowhere to go: the tour is one errand after another and a beat
 * about four number keys read as a card about a toy wedged into the middle of
 * it. What it was waiting for was a reason, and "there is a shopper" was never
 * one — a wave in an empty shop is a toy, and the same wave in front of somebody
 * about to storm out is the only thing in the game that moves a visit upward for
 * free (`answerWave`, `WAVE_MOOD`, `WAVE_CALM`).
 *
 * So it is the `wave` LESSON, down in `LESSONS`, fired by somebody being visibly
 * cross. Two things about the parked version are worth knowing about, because
 * both of them went with the demand and neither is a loss. It had a `done` LATCH
 * (an emote is over in a couple of seconds and `done` is asked on the snapshot,
 * so a wave made and finished between two packets would have left the card
 * asking for something you had already done) — a briefing asks for nothing, so
 * there is no predicate to race. And it had a `skipWhen` for the pill, which is
 * on the lesson's `when` instead: a page skipped on a phone would tick the
 * lesson off as learned and toast about a press that cannot be made.
 */

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
 * the left button takes, the right button puts, and a hold on a fixture opens
 * what it can do. Four beats, no money, nothing that changes what the shop IS.
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
    // The same shopfront the host's welcome card carries — a guest's first
    // card is about the same building from the other side of the door, and a
    // read-only card with an empty well is three lines over a hole.
    art: helloArt,
    say: 'You are in. Same shop, same till — you are the second shopkeeper.',
    hint: 'Everything is shared, money included. This shows you the hands-on '
      + 'half. Skip is bottom right, on every card.',
    big: true,
  },

  {
    id: 'g-walk',
    kicker: 'Getting about',
    say: (t) => perInput(
      t.step?.spot ? 'Click the marked tile. You walk to it.' : 'Click a bit of floor. You walk to it.',
      t.step?.spot ? 'Tap the marked tile. You walk to it.' : 'Tap a bit of floor. You walk to it.',
    ),
    // The same picture and the same small print as `walk` — see the note there.
    art: viewArt,
    hint: viewHint,
    // ...and the view is handed back here: the playing pitch, on whichever
    // corner the ringed tile is on. See `walkShot`.
    shot: walkShot,
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
      return perInput('Now click it again to fill your arms from it.',
        'Now press the top row on the bar along the bottom.');
    },
    hint: () => perInput(
      'Left click picks up, right click drops off. Same on every crate, shelf '
        + 'and machine in the shop.',
      'That bar lists everything this thing can do. Same for every crate, shelf '
        + 'and machine in the shop.',
    ),
    // The picture follows the target, because this card's target is whichever
    // of the two the shop happens to have — see the note on `say`.
    art: (t) => (nearestCrate(t) ? artForCrate() : artOfUnit(t, anyShelf(t))),
    at: (t) => {
      const c = nearestCrate(t);
      return c ? { world: c, y: CRATE_Y } : atUnit(anyShelf(t), SHELF_Y);
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
    say: () => perInput('RIGHT-click a shelf to put it all on.',
      'Tap a shelf, then press Stock it.'),
    hint: () => perInput(
      'Left picks up, right drops off. Arrows point at every shelf that will '
        + 'take what you are holding.',
      'Stock it pours in everything that fits. Arrows point at every shelf that '
        + 'will take what you are holding.',
    ),
    art: (t) => artOfUnit(t, anyShelf(t)),
    // The key to the two arrows, the same one the host's `pour` beat carries —
    // a guest is shelving into the same shop and reads the same marks.
    legend: arrowArt,
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
      'A click uses a thing. Holding opens what it can do — the price, what it '
        + 'is kept for, what is on it. Every shelf, crate and machine has one.',
      'A tap lists what a thing can do along the bottom. Holding opens the '
        + 'whole menu. Every shelf, crate and machine has one.',
    ),
    art: (t) => artOfUnit(t, anyShelf(t)),
    at: (t) => ({ world: anyShelf(t), y: SHELF_Y }),
    done(t) { return t.ui.openPanel === 'fixture'; },
  },

  {
    id: 'g-off',
    kicker: 'That is the lot',
    art: helloArt,
    say: 'That is the hands. The rest of the shop works the same for you.',
    hint: 'Crew, prices, ordering and building are yours too. If your host '
      + 'leaves, the shop goes with them.',
    big: true,
  },
];

// ---------------------------------------------------------------------------
// The lessons
// ---------------------------------------------------------------------------

/** The layout the renderer is holding — where every conveyor cell lives. */
const layoutOf = (t) => t.scene?.storeLayout ?? null;
/**
 * Has anybody painted the crew somewhere to charge?
 *
 * The pad rides on the layout as a region the same way the bay and the drop-off
 * do (`padRegion('break')`, server/layout.js), so this is a question about the
 * SHOP rather than about a press — a pad painted by the friend on the other side
 * of a co-op shop counts, which is the rule every predicate in here obeys.
 */
const breakPad = (t) => ((layoutOf(t)?.break ?? []).length > 0);
/**
 * Low enough to be worth saying something about, and deliberately not zero.
 *
 * `tiredness` stretches everything a hire does by up to `TIRED_PACE`, on a curve
 * with no cliff in it — so there is no number the sim itself calls "low" and
 * this is the tutor's own judgement rather than a constant borrowed from
 * somewhere it would drift out of step with. A quarter is far enough down to be
 * heading somewhere bad and early enough that the shop can still be fixed before
 * it gets there; at zero the card arrives after the damage, at a hire who is by
 * then on their way to rest against a shelf, which is the picture that makes the
 * problem look like it is already solving itself.
 */
const ENERGY_LOW = 0.25;

/**
 * A GAUGE THAT HAS BEEN OFF GREEN LONG ENOUGH TO MEAN SOMETHING.
 *
 * The three bars in the corner are the only thing in the game that reports a
 * problem without naming one, and nothing anywhere says what they are. So they
 * get a card each — and the whole difficulty is the trigger, because every one
 * of them dips constantly in the ordinary course of a day. Two people at a till
 * moves Mood, one busy minute moves Room, and a card that fired on either is a
 * tutorial that goes off while the shop is working.
 *
 * The tone is `gauge`'s and not a number of this file's own, which is the point
 * of it living in `client/hud-meters.js`: the bar's amber is argued for as
 * "a shop with a problem rather than a shop in a hole" (see `setGauges`), which
 * is exactly the drop worth a card — big enough to be real, small enough to
 * still be fixable. Restating those six numbers here would ship as a card that
 * explains a bar which is still green.
 *
 * And then it has to STAY there. `maybeLesson`'s own settle is two seconds,
 * which is right for a purchase and nothing at all for a bar that wobbles: this
 * counts from the first pass off green and clears the moment it comes back, so
 * what fires is a shop that has been in trouble for a quarter of a minute
 * rather than one that had a rush.
 *
 * `bad` and `shut` count as well as `warn`. A player whose Room bar went
 * straight from green to red needs the card MORE, not less, and a trigger that
 * insisted on catching amber on the way past would miss exactly the shops that
 * are worst off.
 *
 * ⚠️ It is a predicate that WRITES, which nothing else in here does, and there
 * is one thing to know about that: `maybeLesson` returns early while any card
 * is open (`this.on`), so the clock is not ticked down while somebody is
 * reading — it simply keeps whatever it had. That is the honest direction. The
 * bar really was down for those seconds.
 */
const GAUGE_DIP_MS = 15000;

/**
 * ...and the clock itself, which is the half worth sharing.
 *
 * Every `when` about a shop in TROUBLE has the same problem: the state it
 * watches is also what a busy minute looks like. A bar dips, a van lands and
 * fills the bay, a queue forms and clears. `heldFor` is "this has been true
 * without a break for long enough to mean it" — one Map on the tour, keyed by
 * whatever the caller calls it, cleared the instant the thing stops being true.
 * The alternative every time is a threshold tuned until it stops crying wolf,
 * which is a number that ends up describing a disaster rather than a problem.
 */
function heldFor(t, key, ok, ms) {
  t.dips ??= new Map();
  if (!ok) { t.dips.delete(key); return false; }
  const since = t.dips.get(key) ?? Date.now();
  t.dips.set(key, since);
  return Date.now() - since >= ms;
}

const sagging = (t, id) => heldFor(t, `gauge:${id}`,
  gauge(id, t.state ?? {}).tone !== 'good', GAUGE_DIP_MS);

/**
 * HOW FULL THE YARD IS, as a fraction, over the bay and the drop-off together.
 *
 * One cell holds one crate — the rule the pads have had since they became
 * paintable, which is what makes how big you paint one a decision — so the
 * count of boxes standing on those cells over the number of cells IS how full
 * it is. Read off the layout and the crates rather than asked for on the wire,
 * because both halves are already there: `bay` and `drop` are regions with
 * their cells on them, and every crate carries where it is standing.
 *
 * The two pads TOGETHER, and that is the whole reason this is one number rather
 * than two. They are one problem — the shop has more stock than it has anywhere
 * to put — and a shop that keeps a small bay and a big stockroom is not in
 * trouble because one of them is full. `bayRoom` on the wire is the other
 * question (what will the supplier still let you order) and cannot answer this
 * one: it is a count of units with no denominator, so a full six-cell bay and a
 * full sixty-cell one read the same.
 *
 * Boxes riding a conveyor are not standing anywhere and are somebody else's
 * problem; rubbish is not, and counts, because a skip's worth of rot parked on
 * the dock is taking exactly the same cells.
 */
function padLoad(t) {
  const L = layoutOf(t);
  const cells = [...(L?.bay?.cells ?? []), ...(L?.drop?.cells ?? [])];
  if (!cells.length) return 0;
  const on = new Set(cells.map((c) => `${c.x},${c.z}`));
  const boxes = (t.state?.deliveries ?? [])
    .filter((d) => !d.belt && on.has(`${Math.round(d.x)},${Math.round(d.z)}`));
  return boxes.length / cells.length;
}

/**
 * Full enough to be a problem, for long enough to not be a delivery.
 *
 * The hold is doing the real work here. A van lands its whole run in one tick
 * and the crew clear it over the next minute, so the bay is legitimately at the
 * brim several times a day in a shop that is working perfectly — fire on the
 * fraction alone and the card arrives on every delivery, which is a tutorial
 * that goes off when the game goes right. Still full most of a minute later is
 * a shop with nowhere to put things.
 */
const PAD_FULL = 0.6;
const PAD_HOLD_MS = 45000;

/**
 * ...and the picture of the bar the card is about — drawn, never cloned.
 *
 * `mockOf` is the usual answer for a HUD control and cannot be used here, for a
 * reason worth writing down before somebody tries it: it strips `style` off the
 * clone (see its own note), and a gauge's LENGTH is an inline style. What comes
 * back is three empty tracks, which is a picture of a readout with no data in
 * it — the opposite of the card.
 *
 * Drawn also lets it say the thing the card is for. The real gauge is 42x5
 * pixels in the corner of the screen; this is the same three rows at about
 * twice the size with the one being talked about short and amber, so the
 * picture IS the sentence "that bar, that colour". Same two colours the HUD
 * uses (`--good`, `--warn`), out of the same variables, so a repaint takes the
 * card with it.
 */
const GAUGE_TAGS = { rep: 'Rep', mood: 'Mood', room: 'Room' };

function gaugeArt(which) {
  const rows = Object.entries(GAUGE_TAGS).map(([id, tag]) => {
    const low = id === which;
    return `<div class="tt-gg"><span class="tt-gtag">${tag}</span>`
      + `<span class="tt-gtrack"><i class="${low ? 'low' : ''}" `
      + `style="width:${low ? 32 : 88}%"></i></span></div>`;
  });
  return `<div class="tt-gauges">${rows.join('')}</div>`;
}

/**
 * WHAT IS DRAGGING THE MOOD DOWN, as one of three, in the order the sim
 * charges for them.
 *
 * Mood is the one bar with several causes, so a card that said "people are fed
 * up" would be a readout in words — true, and not a press. `stepMood` adds up
 * exactly three things on top of the flat rate of being in a shop at all
 * (server/sim/index.js): the line, the crush, and the mess, at 1.0, 1.2 per
 * whole multiple over `CROWD_FROM`, and 0.9 over `MESS_FROM`. Every one of them
 * is a thing the player can go and do something about in the next few seconds,
 * so the card names whichever one is actually happening.
 *
 * The crush is deliberately LAST despite being the dearest, and hands over to
 * the Room bar's own card rather than repeating it: a shop that is too small is
 * not something you fix in the next few seconds, and Room is the bar that
 * exists to say it. Falling through to `null` is a mood dragged down by nothing
 * on this list — an ugly shop, which is `moodBase` and charm — and that is a
 * sentence rather than a press.
 *
 * The thresholds are restated from the sim rather than shared, and that is the
 * one soft spot in here: `MESS_FROM` is where the shop starts being CHARGED for
 * the mess, so it is the honest line to speak at, and it is a number on the
 * server that this file cannot import. `mess` is on the wire precisely so the
 * client can say something about it (see `snapshot`).
 */
const MESS_FROM = 0.1;

function moodBlame(t) {
  const s = t.state ?? {};
  if ((s.customers ?? []).filter((c) => c.till).length >= 2) return 'line';
  if ((s.mess ?? 0) > MESS_FROM) return 'mess';
  if (gauge('room', s).tone !== 'good') return 'crowd';
  return null;
}

const beltsOf = (t) => layoutOf(t)?.belts ?? [];
const armsOf = (t) => layoutOf(t)?.arms ?? [];

/**
 * How many people are queueing — walkers included.
 *
 * `TO_TILL` as well as `QUEUE`, and it is the same correction `lining` had to
 * make on the server: `leaveShop` re-paths the whole line into `TO_TILL` after
 * every sale, so a count of `QUEUE` alone answers "nobody is waiting" for the
 * length of every shuffle. Read once a second by a card that is asking whether
 * there is a LINE, that would flicker between two and none while a line of four
 * was standing there.
 */
const lining = (t) => (t.state?.customers ?? [])
  .filter((c) => c.state === 'QUEUE' || c.state === 'TO_TILL').length;

/**
 * A LINE, rather than somebody paying.
 *
 * One person at a till is the shop working; the card would then open on the
 * first sale of the first morning, which is the one moment nothing has gone
 * wrong yet. Two is the smallest number that is a queue, and it is the word the
 * player would use for what they are looking at.
 */
const QUEUE_LESSON_AT = 2;

/**
 * The till to point at — and it is pointed AT, in the shop, not drawn on the
 * card.
 *
 * The first cut showed a portrait of a checkout in the picture well, which is
 * the right answer for the Shop briefing (a page about what a till IS, opened
 * from the `?`, very possibly about a till you have not built) and is the wrong
 * answer here by the width of the shop. This card fires because there is a line
 * standing at a real counter *right now*, and "go and stand at the till" from a
 * picture of a generic till is an instruction with no address on it. The mark on
 * the tile is the address.
 *
 * Off the layout rather than the snapshot, for `shelvesOf`'s reason: a checkout
 * record says what a till is doing and never where it is. `atUnit` cuts the
 * outline from the unit's own meshes, so it cannot ring the thing standing one
 * square nearer the camera.
 */
const anyTill = (t) => (layoutOf(t)?.checkouts ?? [])[0] ?? null;

/**
 * The one you would hire to work a till, and a picture of them.
 *
 * A CLERK, by name, because that is the whole answer. The card used to say
 * "pick a robot, then add points to Serve", which is three presses deep in a
 * panel nobody has opened, describing a mechanic (a shift is a ratio) at
 * somebody whose shop has a queue in it right now. There is a robot in the
 * catalogue whose whole job is standing at a till and it costs one press to
 * take on. Name it.
 *
 * By `serve` in its authored jobs rather than by the id `clerk`, or this is
 * `if (item.id === 'tomato')` wearing a hire — the cheapest kind that serves is
 * the right answer whatever anybody authors next. `artForWorker` wants the
 * catalogue row, which is the same row the crew strip draws its tile from.
 */
function clerkKind(t) {
  const rows = (t.ui.catalog?.workers ?? [])
    .filter((w) => (w.jobs ?? []).some((j) => j.job === 'serve' && j.weight > 0));
  return rows.slice().sort((a, b) => (a.wage ?? 1e9) - (b.wage ?? 1e9))[0] ?? null;
}

/**
 * ...and how cross somebody has to be before it is worth saying anything.
 *
 * `anger` rides on the wire already, derived rather than stored:
 * `(MOOD_ANNOYED - mood) / (MOOD_ANNOYED - MOOD_FUMING)`, so 0 is somebody who
 * has merely stopped being delighted and 1 is somebody about to walk out. Half
 * way is the first point the shopper is *visibly* cross — `client/render/face.js`
 * has been scowling for a while by then — which is what makes it a state you
 * can see rather than a number the tutor knows and the player does not.
 *
 * Deliberately short of 1: a wave holds somebody where they are rather than
 * lifting them (`WAVE_CALM`), so a card that waited for fuming would arrive
 * with nothing left to save.
 */
const ANGER_HIGH = 0.5;

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
 * THE TWO ARROWS, drawn rather than described.
 *
 * A shop mid-armful has green chevrons floating over every unit that will take
 * what you are holding, in two weights — solid where the press tops up a pile
 * that is already standing, hollow where it opens a new board (`MARKER_LOOK`
 * `stock` and `stockOpen`, client/render/props.js). That distinction is the
 * only thing on screen saying which presses cost you a board, and it was a
 * clause in the middle of a five-line paragraph: "a solid arrow means that
 * shelf has some already, a see-through one means it starts a new pile". Read
 * cold by somebody who has never seen either arrow, that is two abstractions
 * held in the head at once, and the pictures are three tiles away in the shop.
 *
 * So the card draws them, one to a row, with the sentence beside each — under
 * the words, in the `legend` slot, and never in the picture well. The well is
 * the shelf: that is what the card is ABOUT, and a key to two marks is a
 * footnote with pictures in it rather than a portrait.
 *
 * Drawn here and NOT cloned out of the shop, which is the one place this file
 * breaks its own rule (`mockOf`) and it is not a choice: a chevron is a cone in
 * a three.js scene rather than an element on the page, so there is nothing to
 * copy. What keeps the two honest is that the numbers are lifted straight off
 * `MARKER_LOOK` — the same green, the same ten-sided cone read as a triangle,
 * and the ghosted one at `fade` 0.3 with its edges kept, which is exactly what
 * `stockOpen` is: keep the silhouette, give up the fill.
 */
const ARROW_GREEN = '#7cc46a';
const arrowRow = (open, say) => `
  <div class="tt-key-row">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21 L3 6 H21 Z" fill="${ARROW_GREEN}"
        ${open ? `fill-opacity=".3" stroke="${ARROW_GREEN}" stroke-width="2" stroke-linejoin="round"` : ''}/>
    </svg>
    <span>${esc(say)}</span>
  </div>`;

/**
 * A NUMBERED-FEELING LIST WITH A GLYPH ON EVERY LINE, in the same slot the two
 * green arrows use.
 *
 * A card that has to say "do this, then this, then this" was a paragraph of
 * commas — *"press H for your Crew, then take on a Clerk"* — and a paragraph is
 * the one shape a list must not be: you cannot see how many steps there are,
 * which one you are on, or where one ends and the next starts. Three short
 * lines with the game's own icon down the left is read at a glance, and the icon
 * is the thing you then go and look for on screen.
 *
 * `ICONS` rather than anything drawn here, for `mockOf`'s reason said about a
 * glyph: the rail wears these exact marks, so the picture beside "open your
 * Crew" IS the button, and a set somebody regenerates tomorrow comes with it.
 * The sentence goes through `keyed`, so a step whose address is a key gets a key
 * cap in the row.
 */
const iconRow = (svg, say) => `
  <div class="tt-key-row">${svg}<span>${keyed(say)}</span></div>`;

/**
 * A PRESS, DRAWN — which button, and whether it is held.
 *
 * The one thing the whole tutorial exists to teach is that a quick press and a
 * held press are two different verbs, and it was being taught in *prose*: "a
 * quick click takes stock off it, HOLDING opens the shelf itself". That is the
 * shape this file's own rules call a paragraph of alternatives — two abstract
 * halves of one sentence, in a card whose picture well is showing something
 * else entirely.
 *
 * So it is the pill's own glyph. `mouseGlyph` is the exact mouse the press hint
 * has been putting in front of the player since the first crate, with the exact
 * button filled in, which is `client/thumb.js`'s argument about the palette said
 * about a gesture: the card teaches the press in the vocabulary the HUD has
 * already been speaking. A hand-drawn mouse here would be a picture of a mouse;
 * this is a picture of the thing the pill means.
 *
 * The HOLD is a **ring round it**, because that is what a hold looks like in the
 * shop — `stepActions` winds a charge ring on the target for as long as the
 * button is down, and it is green, and it is the only thing on screen that ever
 * says "keep holding". Drawing a second identical mouse and captioning one of
 * them HOLD is what the pill does in a 9.5px strip where there is no room for
 * anything else; on a card with room, the two rows have to be told apart by
 * looking rather than by reading.
 */
const pressRow = (hold, say, right = false) => iconRow(
  '<svg class="tt-press" viewBox="0 0 24 24" aria-hidden="true">'
  // Three-quarters of a turn, opening at the top left, so it reads as a ring
  // that is still winding rather than as a circle drawn round the mouse.
  + (hold ? '<path class="tt-hold-arc" d="M8.5 3.6 A 10 10 0 1 1 3.6 15.5"/>' : '')
  + mouseGlyph(right, 'x="7.8" y="6" width="8.4" height="12"')
  + '</svg>',
  say,
);

/**
 * A COLOUR, drawn as the colour — for a card explaining what a colour means.
 *
 * The build ghost says three things with two of them and nothing on screen
 * names either: green is "it fits", amber is "it fits and will block
 * something", and the gold square on the floor beside it is the side people
 * stand on to use the thing. All three were a paragraph, which is the worst
 * possible shape for it — you cannot match a word to a colour you are looking
 * at without holding both in your head.
 *
 * Straight off `GHOST_COLOURS` and `MARKER_LOOK` (client/render/props.js), the
 * way `arrowRow` lifts the chevron's green: the swatch is the colour the shop
 * is drawing, or the card is teaching a key to a picture nobody is looking at.
 */
const swatchRow = (hex, say) => iconRow(
  `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18"
    height="18" rx="2" fill="${hex}" stroke="rgba(58,49,40,.55)" stroke-width="1.6"/></svg>`,
  say,
);

/* A declaration, for the reason `viewHint` gives: the step table above names it. */
function arrowArt() {
  return arrowRow(false, 'This shelf already has some. It goes on that pile.')
    + arrowRow(true, 'This shelf has none. It starts a new pile.');
}

/**
 * THE SMALL PRINT UNDER THE VIEW CARD, written once for both tours.
 *
 * The host's `walk` and the guest's `g-walk` are the same lesson said to two
 * people, and this copy was in both of them — which is fine right up until one
 * gets a sentence the other does not, and then the guest is quietly playing an
 * older game. The guest card already said "the same small print as `walk` — see
 * the note there", which is a comment doing a function's job.
 *
 * Two paragraphs, and the split is the whole reason `keyed` learned about a
 * blank line: the first is how you MOVE and the second is how CLOSE you are.
 * Read as one block they are a list of five things on the second card of the
 * game, which is where somebody decides whether these cards are worth reading.
 *
 * First person is a KEY here and never the wheel, and that is a rewrite rather
 * than a shortening. It is true that the last notch of the zoom drops you into
 * your own shoes and it takes three clauses to say — "keep going past the
 * closest it will get" is a gesture described by its own boundary condition,
 * which is exactly the kind of sentence somebody seven years old stops reading
 * in the middle of. `F` is one key and one outcome, in and out, and the wheel
 * finds itself. What went is the explanation of a thing that needs no
 * explaining once you have pressed the key.
 *
 * A `function` and not a `const`, which is the one thing here that is not
 * taste: both step tables are array literals ABOVE this line, and a `const`
 * named in one of them is read before it is initialised. A declaration hoists,
 * so the tables can name it wherever it happens to be written.
 */
function viewHint() {
  return perInput(
    'Hold the right mouse button and drag to look round the shop. [[,]] and '
      + '[[.]] swing it a quarter turn. [[W]] [[A]] [[S]] [[D]] walk you about '
      + 'without clicking.'
      + '\n\n'
      + 'The wheel zooms in and out. [[F]] drops you into your own shoes and '
      + 'back out again.',
    'Twist with two fingers to look round the shop. Pinch to zoom, and one '
      + 'finger slides it about.',
  );
}

/**
 * A picture of a CONTROL, taken from the control.
 *
 * "Open the crew strip", "open the supplier", "click the sign" — every one of
 * those is an instruction to press a button somewhere on the HUD, and the card
 * said it in words while the picture well underneath sat empty. The mark in the
 * shop is round the button the whole time, and that is exactly the half that
 * does not help: you have to have FOUND the button to see the mark on it. A
 * seven-year-old reading "open the crew strip" is looking for a strip.
 *
 * So the well shows the button. Not a drawing of it — the button, cloned out of
 * the live HUD, which is `client/thumb.js`'s argument about the palette said
 * about a control: a rail button that somebody restyles tomorrow restyles its
 * card with no second picture to keep in step.
 *
 * Three things about the clone, and each of them is a bug if it is left out.
 * Every **id and data attribute goes** — `holeFor` and half the HUD find things
 * with `document.querySelector`, and a second `[data-rail="staff"]` sitting in
 * the tutor overlay is a mark that could land on the picture instead of on the
 * thing. It is **inert**: `aria-hidden`, `disabled`, no tooltip, since a picture
 * of a button that answers a press is a second button. And the **state classes
 * come off** (`on`, `open`, `armed`, `waiting`, `landing`), or the card shows
 * the lit version of a button whose whole card is about it not being lit yet.
 *
 * It is scaled to the well by `mockAt` rather than sized here, because how big
 * the control is on screen is the player's own HUD dial (`ui-scale.js`) and the
 * well is a fixed 168px.
 */
const MOCK_STRIP = ['id', 'data-entry', 'data-rail', 'data-slot', 'data-more',
  'data-tip', 'data-tip-key', 'data-tip-note', 'data-tip-wait', 'title', 'style'];
const MOCK_STATES = ['on', 'open', 'armed', 'waiting', 'landing', 'poor', 'off'];

function mockOf(sel) {
  // The sign is the one control on the HUD whose look is written against its own
  // id (`#sign`, `#doorway` in index.html), so a clone with the id taken off is
  // an unstyled box — and leaving the id on would put a second `#sign` in the
  // document, which is the trap the note above is about. It is drawn instead,
  // in the tutor's own stylesheet, from the same two colours.
  // ...and it is drawn WITH A BIT OF THE CARD IT IS AN EDGE OF, which is the
  // difference between a picture of the button and a picture of where the button
  // is. The sign is not an object standing on the readout, it is the readout's
  // left-hand edge (see `#sign` in index.html), so a strip on its own is a red
  // rectangle nobody could find. The card's own contents are two bars rather
  // than the day and the balance: the card is a landmark here, and real numbers
  // on it would be a second thing to read that is also wrong by morning. It
  // fades out to the right because what is being said is "this end of that".
  if (sel === 'sign') {
    return '<div class="tt-hudcard"><div class="tt-sign shut"><span>SHUT</span></div>'
      + '<div class="tt-rows"><i></i><i></i></div></div>';
  }
  const src = document.querySelector(sel);
  if (!src) return null;
  const el = src.cloneNode(true);
  for (const n of [el, ...el.querySelectorAll('*')]) {
    for (const a of MOCK_STRIP) n.removeAttribute?.(a);
    n.classList?.remove(...MOCK_STATES);
    if (n.tagName === 'BUTTON') n.disabled = true;
  }
  el.setAttribute('aria-hidden', 'true');
  return el.outerHTML;
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
   * A ROBOT THAT HAS RUN DOWN, AND NOWHERE TO PLUG IN.
   *
   * The first lesson in this list whose trigger is a shop in TROUBLE rather
   * than a shop that just bought something, and it is the shape this file's own
   * header asks for: `when` is what being stuck looks like. Being stuck here is
   * two facts at once — somebody on the payroll is nearly flat, and there is no
   * charging pad anywhere in the building.
   *
   * Both halves, and the second is what keeps it from nagging. A hire runs low
   * every single day in every shop there has ever been; that is the resource
   * working. What is worth interrupting somebody about is running low with
   * nowhere to go, because THAT is the state with a consequence you cannot see.
   *
   * AND THE CARD SAID THE WRONG THING ABOUT IT FOR A WHILE, which is worth
   * keeping because the wrong version is the one that sounds better. It read
   * "they never stop — they just do everything at half speed", and they do
   * stop: `seatIn` (server/sim/staff.js) answers null when there is no room,
   * and a hire with no seat takes the break where the pastime authored it,
   * which is leaning on whatever they are standing next to. That fallback is
   * the whole promise of the feature — see `verify:break`, whose first claim is
   * that a shop with no break area still takes breaks.
   *
   * What the room actually buys is two things and neither is "a break at all".
   * A seated break restores `SEATED_RESTORE` — half as much again — so they are
   * up sooner and go down less often, which is what pays for the walk round.
   * And they rest THERE rather than in the middle of an aisle. The slowness is
   * real and is the other half of it (`tiredness` stretches everything by up to
   * `TIRED_PACE` while they are low), but it is a consequence of resting badly
   * rather than of never resting.
   *
   * A `when` and not an `owns`, obviously, but worth saying why the owns-shaped
   * version is wrong: "the shop has no break area" is true of every shop on day
   * one and of most shops for ever, so it is a level rather than a state, and it
   * would open this card at somebody who has three hires and no need of one yet.
   *
   * `ENERGY_LOW` rather than zero, because a card that waits for flat has waited
   * until the damage is done — and because a hire at zero is on their way to
   * rest somewhere by then, which is the picture that makes the problem look
   * solved.
   *
   * No `group`, and the toast says nothing about the `?`. The other three
   * lessons are briefings about a build TAB and that is what the button brings
   * back; this one is about a situation, and a `?` that reopened it would be a
   * help button answering a question the shop is no longer asking.
   */
  {
    id: 'charge',
    when: (t) => !breakPad(t) && (t.state?.players ?? [])
      .some((p) => p.staff && Number.isFinite(p.energy) && p.energy <= ENERGY_LOW),
    toast: 'Paint a charging pad from the Logistics tab',
    steps: [
      {
        id: 'c-flat',
        kicker: 'Running low',
        // The robot it is about, drawn from their own row — the flattest one in
        // the shop, so the picture is the hire you would go and look at.
        // `p.hire` and `p.tier` off the body, never `id.replace(/^staff-/)` —
        // the snapshot carries that key for exactly this reason, and rebuilding
        // it from the id makes an id format a protocol (see `snapshot`).
        art: (t) => {
          const low = (t.state?.players ?? [])
            .filter((p) => p.staff && Number.isFinite(p.energy))
            .sort((a, b) => a.energy - b.energy)[0];
          const who = (t.state?.roster ?? []).find((r) => r.id === low?.hire)
            ?? (t.state?.roster ?? [])[0];
          const kind = (t.ui.catalog?.workers ?? []).find((w) => w.id === who?.kind);
          return kind ? artForWorker(kind, low?.tier ?? who?.tier ?? 1) : null;
        },
        say: 'One of your robots is nearly out of charge.',
        hint: 'They stop and rest right where they stand. A pad puts more back, '
          + 'so they are up sooner and out of the way.',
      },
      {
        id: 'c-pad',
        kicker: 'The charging pad',
        // The brush's own swatch, exactly as a page about a fixture shows the
        // fixture: `artOf` forks on `surface` for precisely this row.
        art: (t) => artOf(t, 'break'),
        say: 'Paint a charging pad. They plug in there.',
        hint: 'One square charges one robot, so paint a few. They take '
          + 'themselves off to it when the shop is quiet.',
        // The three presses, one to a line. The tab is named because a brush
        // is not where anybody looks for a floor for the crew.
        //
        // AND EVERY ICON IS THE ONE ON THE THING IT NAMES. A row that says
        // "open the Logistics tab" beside a picture that is not the Logistics
        // tab is a treasure hunt: this said it beside `runner`, a porter's
        // trolley, while the tab on the bar wears `crate` — so the one row in
        // the list whose whole job is telling you which of six buttons to press
        // was pointing at none of them. `BUILD_GROUPS` in `client/sections.js`
        // is where they are set (`shop` shelf, `appliance` station, `farm`
        // plot, `logistics` crate, `shell` build, `outdoors` outdoors), and it
        // cannot be imported here — sections.js imports THIS file, for the
        // Menu's tutorial switches — so the rule is a look rather than a
        // lookup. Check it against that table when writing a row that names a
        // tab.
        legend: () => iconRow(ICONS.build, perInput('Press [[G]] twice for the '
          + 'build bar', 'Press the hammer twice for the build bar'))
          + iconRow(ICONS.crate, 'Open the Logistics tab')
          + iconRow(ICONS.floor, 'Drag out a patch of floor anywhere they can walk'),
      },
    ],
  },

  /**
   * THE FIRST LINE AT THE TILL.
   *
   * The tour builds a shelf, fills it and opens the shutters, and then stops —
   * so the first thing that happens in the shop after the tutorial ends is a
   * queue, and not one word anywhere has said what to do about one.
   *
   * WHICH IS THE ONLY THING THIS CARD IS ALLOWED TO SAY, and the first cut got
   * it wrong in the way this file's own rules already warn about. It explained
   * what a till is: leave clear squares beside it to queue in, cash piles up on
   * the counter, a dearer one is faster. Every word true, every word useless —
   * a line has just formed, the question in the player's head is "what do I
   * press", and none of that answers it. Worse, "leave clear squares beside it"
   * is advice about where to BUILD a till, read by somebody who cannot build
   * anything at this moment and would not want to if they could.
   *
   * So: one press a card, and the press comes first. Go and stand at it. If you
   * are sick of standing at it, put a robot on it. Everything else about tills —
   * the queue room, the ladder, the money on the counter — is the Shop briefing's
   * `s-till` page, which is where you go to READ about a till rather than to get
   * a line served.
   *
   * The failure this catches is the quietest in the game. A till with nobody on
   * it is a till: it draws the same, it logs nothing, and the line simply gets
   * longer until people storm out at −0.03 reputation each. Thirty-four of those
   * is the whole range of the bar (see CLAUDE.md on the idle room), so a shop
   * can be turned on by the town inside one afternoon with nothing on screen
   * ever having said why. The ledger blames "Lost patience", which is exactly
   * what happened and says nothing about nobody having been there.
   *
   * A `when` and not an `owns`: standing a till down is not the moment — you
   * start with one — and a queue is. `QUEUE_LESSON_AT` is what makes it a state
   * rather than a level: one person at a counter is the shop working, and a
   * line is the first time the arrangement is under any strain at all.
   *
   * No `group`, and the toast says nothing about the `?` — `charge`'s argument
   * exactly. The other three lessons are briefings about a build TAB and that
   * is what the button brings back; this one is about a situation, and a `?`
   * that reopened it would be a help button answering a question the shop is no
   * longer asking. The till's own page in the Shop briefing is the thing you
   * can go back and read.
   */
  {
    id: 'queue',
    when: (t) => lining(t) >= QUEUE_LESSON_AT,
    toast: 'Somebody has to be on the till',
    steps: [
      {
        // BOTH: the real till gets the frame in the shop, and the card shows
        // what it is looking for. Dropping the picture because the thing is
        // marked was tried and is wrong — the well went empty, and a card with
        // a hole where its picture goes reads as broken. `pour` in the tour
        // makes the same pair for the same reason.
        id: 'q-till',
        kicker: 'You have a queue',
        kind: 'checkout',
        at: (t) => atUnit(anyTill(t), SHELF_Y),
        say: 'Go and stand at the marked till. You serve them yourself.',
        hint: 'Nobody there, nobody served. They get cross and walk out.',
      },

      {
        /**
         * ...and the other answer, which is a press rather than a purchase.
         *
         * A picture of the CONTROL and not of a robot, for `mockOf`'s own
         * reason: "open the crew strip" is an instruction to press a button
         * somewhere on the HUD, and a seven-year-old reading it is looking for
         * a strip. The `{ mock }`-only shape of `at` is exactly this case — a
         * card with a picture of a button and nothing to draw a frame round,
         * because a lesson marks nothing in the shop and asks for nothing.
         */
        id: 'q-clerk',
        kicker: 'Hire a Clerk',
        // The robot you are being told to hire, drawn from the same row the
        // crew strip draws its tile from — see `clerkKind`.
        art: (t) => {
          const k = clerkKind(t);
          return k ? artForWorker(k) : null;
        },
        say: (t) => `Standing there all day is no fun. Hire a ${clerkKind(t)?.name ?? 'Clerk'}.`,
        hint: 'They stand at the till all day so you do not have to.',
        // The three presses, one to a line — see `iconRow`. The second tap is
        // not a flourish: a hire refunds nothing, so the tile arms itself and
        // says "Tap to hire" before it spends anything (`staffGroups`), and a
        // card that stopped at "tap the Clerk" would read as the press having
        // failed.
        legend: (t) => {
          const who = clerkKind(t)?.name ?? 'Clerk';
          return iconRow(ICONS.staff, perInput('Press [[H]] for your Crew',
            'Press Crew on the right'))
            // "Lease" is what the tab says (`staffGroups`, client/sections.js),
            // and this row said "the + tab" — a name that is on nothing on
            // screen, in the one list whose whole job is naming the presses in
            // order. Same rule as the Logistics icon above: a row that names a
            // tab has to carry the tab's own word and the tab's own picture.
            + iconRow(ICONS.hire, 'Open the Lease tab')
            + iconRow(ICONS.clerk, perInput(
              `Click the ${who}, then click again to hire`,
              `Tap the ${who}, then tap again to hire`,
            ));
        },
      },

      /**
       * ...and where it ends, which is the half that makes the other two a
       * LADDER rather than two chores.
       *
       * The portrait belongs on this page and not on the first one: this is the
       * only page about a till you have not got yet, so the picture is doing
       * the job it does in every other briefing — showing you the thing that is
       * coming.
       */
      {
        id: 'q-auto',
        kicker: 'Then nobody',
        kind: 'checkout',
        say: 'The best till serves people all by itself.',
        // "Press and hold" is the one gesture that is the same sentence in both
        // grammars — see the tour's `menu` beat — so this needs no `perInput`.
        hint: 'Press and hold on the till to open its menu, then press Upgrade. '
          + 'Every one is faster, and the last needs nobody stood there.',
      },
    ],
  },

  /**
   * SOMEBODY IS CROSS, AND THERE IS ONE THING YOU CAN DO ABOUT IT NOW.
   *
   * This card was written a long time ago and parked, as `WAVE_STEP`, because
   * it had no moment: emotes are the one press in the game nothing on screen
   * mentions — four number keys, no button, no menu, no ring — and a beat about
   * them wedged into the tour read as a card about a toy in a run of cards about
   * getting a shop going. The moment it was waiting for is this one. A wave is a
   * toy in an empty shop and it is a tool in front of somebody who is about to
   * walk out.
   *
   * `ANGER_HIGH` rather than "there is a shopper", which is the level trap this
   * file is written around: every shop that has ever traded has a shopper in it.
   * Being cross is a state, it is one you can see on the face
   * (`client/render/face.js`), and it is one with a consequence — a storm-out is
   * −0.03 on the slowest number in the game.
   *
   * It opens BEHIND the award card rather than over it, and that costs nothing
   * to arrange: `maybeLesson` already refuses while `ui.award.waiting`, and the
   * settle restarts once it is dismissed. A milestone stops the world and takes
   * the screen; a second card behind it is one nobody reads.
   *
   * ⚠️ The whole lesson is off where the pill drives. There is no keyboard, the
   * strip only opens from [[V]], and a card naming a press that cannot be made
   * is worse than no card — which is `perInput`'s own argument, said about a
   * page rather than about a sentence. It is on the LESSON rather than as a
   * `skipWhen` on the page, or a shop on a phone would tick the lesson off as
   * learned and toast about it.
   */
  {
    id: 'wave',
    when: (t) => !pillDrives()
      && (t.state?.customers ?? []).some((c) => (c.anger ?? 0) >= ANGER_HIGH),
    // Plain words and no key caps: a toast is text rather than a card, so it
    // never goes through `keyed` and `[[1]]` would land on screen as brackets.
    toast: 'Wave with 1 to 4 to calm people down',
    steps: [
      {
        id: 'w-wave',
        kicker: 'Saying hello',
        /**
         * The strip is a row of buttons nobody has ever seen, so the card shows
         * one of them — with the `1` in its corner, which is where the number in
         * the sentence comes from. Holding [[V]] puts the whole row on screen and
         * is deliberately not what the card leads with: the numbers work with it
         * down, so leading on the strip would teach a press you do not need.
         */
        at: () => ({ mock: '.em-btn' }),
        /**
         * Build the strip without showing it. `showEmotes` parses four SVGs on
         * the first press and only ever runs from the key, so before anybody has
         * held V there is no button in the document for the card to take its
         * picture of — and it would open with an empty well on the one card whose
         * whole problem is that nothing on screen says this exists. Both calls in
         * the same frame, so nothing is drawn in between and the strip is as down
         * as it was.
         */
        arm(t) { t.ui.showEmotes?.(true); t.ui.showEmotes?.(false); },
        say: 'Somebody is getting cross. Stand near them and press [[1]].',
        hint: 'They wave back and stop getting crosser for a bit. Once each.'
          + '\n\n'
          + 'It buys you time — now go and fix the queue.',
      },
    ],
  },

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
        say: 'A shelf holds a few different things at once, not just one.',
        hint: 'Hold on it to set the price, or keep a space for one thing so the '
          + 'shop buys more of it. Dearer shelves hold more.',
      },

      {
        id: 's-freezer',
        kicker: 'The chiller',
        kind: 'freezer',
        say: 'Frozen food only keeps in a chiller. It lasts four times as long.',
        hint: 'Nothing else goes in one, so buy the chiller BEFORE you order '
          + 'anything frozen.',
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
        say: 'Roast chicken and pies keep warm. Hot food only.',
        hint: 'A chiller is no better for them than a plain shelf. Wrong one is '
          + 'as bad as none.',
      },

      {
        id: 's-till',
        kicker: 'The till',
        kind: 'checkout',
        say: 'A till is where people pay. Somebody has to be behind it.',
        hint: 'Leave a clear line of squares beside it to queue in. Cash piles on '
          + 'the counter — walk over it to grab it.',
      },

      {
        id: 's-bin',
        kicker: 'The skip',
        kind: 'bin',
        say: 'A skip is somewhere to throw things away.',
        hint: 'Your robots carry rotten food out to it. They never bin your good '
          + 'stuff — that is your call. Once it is in, it is gone.',
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
        say: 'A conveyor is a moving floor. It carries boxes along for you.',
        hint: () => perInput(
          'Drag to lay a whole line at once — corners are free. Carry a box over '
            + 'and RIGHT-click the line to put it on.',
          'Drag to lay a whole line at once — corners are free. Carry a box over, '
            + 'then press "Set the crate down here".',
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
        say: 'A conveyor drives straight past your shelves. A loader fills them.',
        hint: 'Put one in your line with a shelf beside it. It reaches all four '
          + 'sides, so one can feed two aisles.',
      },

      {
        id: 'l-sorter',
        kicker: 'The sorter',
        kind: 'sorter',
        say: 'A sorter is a crossroads for boxes.',
        hint: () => 'Bread goes to the bread shelf, ice cream to the freezer. You '
          + 'never tell it which is which. '
          // `perInput`, because there is no [[R]] on a phone — the round button
          // beside the bar is the turn there (`#rotbtn`, `syncRotate`), and a
          // card naming a key nobody has is the failure that helper exists for.
          + perInput('[[R]] points the side branch.',
            'The round turn button points the side branch.'),
      },

      {
        id: 'l-packer',
        kicker: 'The packer',
        kind: 'packer',
        say: 'A packer fills itself from the boxes going past.',
        hint: 'Three half-empty boxes is three trips across the shop. This makes '
          + 'them one full one.',
      },

      {
        id: 'l-under',
        kicker: 'The tunnel',
        kind: 'under',
        say: 'Boxes go in one end and come out the other, underneath everything.',
        hint: 'Put the ends up to four squares apart, both facing the way boxes '
          + 'travel. The middle stays yours to build on.',
      },

      {
        id: 'l-lift',
        kicker: 'The lift',
        kind: 'lift',
        say: 'A lift joins the floor to the ceiling.',
        hint: () => 'Conveyors can run along the ceiling and take up no room at all. '
          + 'A box off the floor goes up; one off the ceiling comes down. '
          // See the sorter page: there is no [[R]] on a phone.
          + perInput('Press [[R]] to pick which side it comes out.',
            'Use the round turn button by the bar to pick which side it comes out.'),
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
        say: 'Plant a rack, it grows on its own, then you pick it.',
        hint: 'Hold on it to buy a seed. Anything your hands cannot hold goes into '
          + 'a box at your feet. A farmhand does all of it for you.',
      },

      {
        id: 'f-pen',
        kicker: 'The vat',
        kind: 'pen',
        say: 'A vat makes food by itself. You only ever take out.',
        hint: 'When it is full it STOPS, so empty it often — a vat left full all '
          + 'night made nothing all night.',
      },

      {
        id: 'f-deck',
        kicker: 'The culture floor',
        kind: 'paddock',
        say: 'Paint floor round a vat and it makes more at once.',
        hint: 'Four squares is one more batch. Two vats on one patch share it, so '
          + 'give each its own. A better vat beats more floor.',
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
        say: 'What you grow is ordinary stock. Shelve it and people buy it.',
        hint: 'A seed is cheaper than a delivery. Keep a shelf or some drop-off '
          + 'space free, or your robots stop picking.',
      },
    ],
  },

  /**
   * ROT ON THE FLOOR AND NOTHING THAT CAN SHIFT IT.
   *
   * The purest `when` in the file: a stuck state, visible from across the shop,
   * with exactly one press that ends it. Spoiled stock stopped evaporating at
   * midnight and became a crate marked `waste` standing where the shelf is
   * (see the note above `anyBin` in server/sim/index.js) — and owning a skip is
   * what lets the crew carry one OUT, never what decides whether rubbish
   * exists. So a shop without one silently accumulates boxes that take floor,
   * cost patience through `mess`, and cannot be moved by anybody.
   *
   * The trigger is a box and not `stats.spoiled`, which is the same claim said
   * the wrong way round: the counter climbs in a shop that owns three skips and
   * is dealing with it perfectly well. What is wrong is the box nothing can
   * lift, so that is what is asked about.
   *
   * No hold (`heldFor`), unlike its neighbours: this state does not wobble.
   * Nothing in the game clears a waste crate except a skip, so the first one is
   * both the earliest and the last honest moment to say something.
   */
  {
    id: 'rubbish',
    when: (t) => (layoutOf(t)?.bins ?? []).length === 0
      && (t.state?.deliveries ?? []).some((d) => d.waste),
    toast: 'Food went off — nothing can shift it',
    steps: [
      {
        id: 'r-skip',
        kicker: 'Rubbish',
        // `kind` and not `art`: the picture comes off the catalog row, so a
        // restyled skip restyles the card, and the `· soon` badge is handled
        // for free if the ladder has not opened the button yet.
        kind: 'bin',
        say: 'Build a Skip. Your robots carry the rubbish out to it.',
        hint: 'Food that goes off turns into boxes. Nothing in the shop can '
          + 'move one until you own a Skip.',
        legend: () => iconRow(ICONS.build, perInput('Press [[G]] twice for the '
          + 'build bar', 'Press the hammer twice for the build bar'))
          // Shop rather than Logistics, and it is worth checking rather than
          // guessing: `KIND_TOOLS.bin` says `group: 'shop'` on the judgement
          // that a skip is a thing you stand somewhere, like a till.
          + iconRow(ICONS.shelf, 'Open the Shop tab')
          + iconRow(ICONS.close, 'Put the Skip down somewhere out of the way'),
      },
    ],
  },

  /**
   * A YARD THAT IS NOT DRAINING.
   *
   * The bay and the drop-off are where everything the shop owns passes through,
   * and when they stop emptying nothing anywhere says so — a full pad and a pad
   * that has just taken a delivery are the same picture. What it costs is
   * invisible in the other direction too: `bayRoom` collapses, so the supplier
   * quietly stops ordering, and what you notice days later is shelves that will
   * not fill (see the `restock` refusal trap in CLAUDE.md).
   *
   * The answer is shelving the shoppers never see, which is the one kind of
   * space that does not compete with the shop floor for room — and the switch
   * that makes a shelf into that is three presses deep in a menu, which is
   * precisely the sort of thing nobody finds on their own.
   */
  {
    id: 'pads',
    when: (t) => heldFor(t, 'pads', padLoad(t) >= PAD_FULL, PAD_HOLD_MS),
    toast: 'Your yard has stopped emptying',
    steps: [
      {
        id: 'p-back',
        kicker: 'Stacking up',
        kind: 'shelf',
        say: 'Boxes are stacking up. Put a shelf out the back.',
        // What the switch is FOR, in the two things it changes that you can see
        // — not what it is. The label it turns into is named because the row is
        // a toggle that reads as its current state, so the words on the button
        // before and after are both worth having.
        hint: 'A shelf set to In the back is crew only, so it never takes shop '
          + 'floor. The shop orders extra to keep it full.',
        legend: () => iconRow(ICONS.build, perInput('Press [[G]] twice for the '
          + 'build bar', 'Press the hammer twice for the build bar'))
          + iconRow(ICONS.shelf, 'Open the Shop tab and stand a shelf out the back')
          + iconRow(ICONS.crate, perInput(
            'Press and hold it, then press On the shop floor',
            'Tap and hold it, then press On the shop floor',
          )),
      },
    ],
  },

  /**
   * THE THREE BARS IN THE CORNER, one card each, when one of them goes amber.
   *
   * The only thing in the game that reports a problem without naming one. They
   * are 42x5 pixels, they carry three words between them, and nothing anywhere
   * says what any of them measures or what to do when one drops — so the shop
   * gets quietly worse while the one part of the screen that knows says so in a
   * language nobody was taught.
   *
   * `when` and not `owns`, obviously. What is worth saying is a shop in trouble
   * (see `sagging` for the trigger and why it has a clock on it), and each card
   * is a briefing about a SITUATION rather than about a build tab — so no
   * `group`, for the reason `charge` has none: the `?` reopens a tab's pages,
   * and there is no tab whose contents are the Rep bar.
   *
   * They go LAST in the array and in this order, and both halves are decisions.
   * Last, because `LESSONS.find` is first-match-wins and every lesson above is
   * about a thing you just built — a card about the shop being crowded should
   * not out-rank the one explaining the conveyor you bought thirty seconds ago.
   * And Room before Mood, because a crush drags both bars down at once and Room
   * is the one that names the fix; Mood hands its crowd branch straight over to
   * it, which only ever reads once this card is learned.
   *
   * ⚠️ None of the three may ever tell you what the bar IS and stop there. That
   * is the whole failure mode of a card about a readout — "Rep is how much of
   * the town picks your shop" is true, is on the hover already, and is not
   * something to press. Every one of these leads with the press and spends the
   * hint on the meaning.
   */
  {
    id: 'gauge-room',
    when: (t) => sagging(t, 'room'),
    toast: 'Your shop is nearly full',
    steps: [
      {
        id: 'g-room',
        kicker: 'Nearly full',
        art: () => gaugeArt('room'),
        /**
         * ...and WHICH of the two halves is the tight one, which is the whole
         * reason `capacityBy` is on the wire.
         *
         * `shopCapacity` is the LOWER of what the tills and stocked shelves can
         * serve and what the floor can hold, and a `min` throws away the only
         * part anybody can act on: a barn with one till and a broom cupboard
         * with six read as exactly the same number. "Your shop is full" would
         * be a complaint; these are two different presses, and the wrong one is
         * money spent on a thing that moves nothing.
         */
        say: (t) => (t.state?.capacityBy === 'service'
          ? 'Your shop is full. Put in another till.'
          : 'Your shop is full. Make the building bigger.'),
        hint: (t) => (t.state?.capacityBy === 'service'
          ? 'A till holds far more people than a shelf does. When this bar runs '
            + 'out, people are turned away at the door.'
          : 'Every square indoors is somebody who can stand in it. When this bar '
            + 'runs out, people are turned away at the door.'),
        legend: (t) => iconRow(ICONS.build, perInput('Press [[G]] twice for the '
          + 'build bar', 'Press the hammer twice for the build bar'))
          + (t.state?.capacityBy === 'service'
            ? iconRow(ICONS.shelf, 'Open the Shop tab')
              + iconRow(ICONS.checkout, 'Put down another till')
            : iconRow(ICONS.build, 'Open the Building tab, then Walls')
              + iconRow(ICONS.house, 'Drag your walls further out')),
      },
    ],
  },

  {
    id: 'gauge-mood',
    // A cause as well as a dip, which is what keeps every branch below a press.
    // Mood dragged down by none of the three (an ugly shop — `moodBase`, which
    // is charm) is a real state and is not something to do in the next few
    // seconds, so it waits rather than getting a card that shrugs.
    when: (t) => sagging(t, 'mood') && !!moodBlame(t),
    toast: 'People in the shop are fed up',
    steps: [
      {
        id: 'g-mood',
        kicker: 'Mood is dropping',
        art: () => gaugeArt('mood'),
        say: (t) => {
          const why = moodBlame(t);
          if (why === 'line') return 'Somebody is waiting. Go and stand at the till.';
          if (why === 'mess') return 'Boxes are all over the floor. Put them away.';
          return 'Your shop is too crowded. Watch the Room bar under this one.';
        },
        // The one thing the bar means, and the reason to care about it at all:
        // it is Rep's early warning, and Rep is the slowest number in the game.
        // Said once, under a sentence that already named the press.
        hint: 'This is how the people in your shop feel right now. Let it sit '
          + 'low and your Rep follows it down.',
      },
    ],
  },

  {
    id: 'gauge-rep',
    when: (t) => sagging(t, 'rep'),
    toast: 'Fewer people are choosing your shop',
    steps: [
      {
        id: 'g-rep',
        kicker: 'Rep is slipping',
        art: () => gaugeArt('rep'),
        // The one card of the three whose press is a PANEL, and it earns that:
        // reputation is seven separate causes added up over days (`REP_CAUSES`,
        // shared/reputation.js), the Shop report draws them worst-first, and no
        // sentence here could name which one is yours. Name + key, off the
        // section row rather than invented — `id: 'shop'`, name Shop, key `t`.
        say: () => perInput('Press [[T]] for Shop. It says what upset people.',
          'Press Shop on the right. It says what upset people.'),
        hint: 'Rep is how much of the town picks you over everywhere else. Fix '
          + 'the biggest thing on that list first.',
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
    // ...and the preview flag with it, or a run started by the shop after one
    // started by `teach` would inherit "you asked for this" and never mark.
    this.asked = false;
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
    // ...and the preview flag with it, or a run started by the shop after one
    // started by `teach` would inherit "you asked for this" and never mark.
    this.asked = false;
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
    // ...and the preview flag with it, or a run started by the shop after one
    // started by `teach` would inherit "you asked for this" and never mark.
    this.asked = false;
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
    // `waiting` rather than `open`, because a card that has been earned and is
    // holding for a gap in play is one that is about to take the screen — and a
    // lesson opened in that gap is the same buried card, one second later.
    if (this.ui?.award?.waiting) { this.wantedAt = 0; return; }
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
  /**
   * ...and ASKING for a lesson does not spend it.
   *
   * It used to: `teach` goes through `start` and out through `quit` like
   * everything else, and `quit` marks a finished lesson learned — which is
   * right for one the shop offered and you read, and exactly wrong for one you
   * went and fetched. Two ways that bites, and both were reported as the
   * feature not working. Reading the copy from the console to check it (the
   * whole reason this call exists) silently switches it off for ever, so a
   * lesson tested once never fires in the shop it was written for. And pressing
   * the `?` on the build bar out of curiosity spends the briefing you have not
   * needed yet.
   *
   * Nothing is lost by leaving it unmarked: if the shop later hits the state,
   * you get the card a second time, which is one card. Losing it is silent and
   * permanent, and the only way back is a console call nobody knows about.
   */
  teach(id) {
    const l = LESSONS.find((x) => x.id === id || x.group === id);
    if (!l || this.on) return false;
    this.lesson = l;
    this.asked = true;
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
    // ...and the camera, for the same reason and in the same breath: a hold
    // still pinned to the last card's tile is the tour steering the view of a
    // shop it has finished talking about.
    this.scene?.releaseHold?.();
    // ...and the walls, which is the other half of "or exits the tutorial": Esc
    // or Skip on the very first card has to give them back too, or a tour turned
    // down leaves the shop uncuttable for the rest of the session.
    this.scene?.holdWallCut?.(false);
    this.el.hidden = true;
    this.el.classList.remove('show');
    document.body.classList.remove('tutoring');
    // Skipping marks it learned, exactly as skipping the tour marks the world
    // done: the offer was made and turned down, and making it again the next
    // time you look at the thing is the tutorial nagging. Menu › Replay is the
    // way back — see `forgetLessons`, which that row now calls beside
    // `replayTutor`.
    const done = this.lesson;
    // ...unless you went and asked for it — see `teach`.
    const asked = this.asked;
    this.asked = false;
    if (done) { if (!asked) addTo(LEARNED_KEY, done.id); }
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
    // The near walls stay WHOLE for the opening card and come back down on the
    // first Next — the argument is at `Scene.holdWallCut`. It is set on every
    // `go` rather than once at `start`, because that is what makes the release
    // fall out of the advance instead of being a second thing to remember: any
    // step but the first hands the walls back, and Back to the first takes them
    // again. Not for a LESSON, which arrives in the middle of a game somebody is
    // already playing and has no opening shot to protect.
    this.scene?.holdWallCut?.(!this.lesson && i === 0);
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
    // A POSE first, where a card has one — see `frontShot`. The angles are set
    // once, and the same "once, when it can be" rule as the centre below: a
    // shot asked for before the layout has landed answers null and is asked
    // again next frame, rather than being spent on a shop that is not there
    // yet.
    const shot = this.step?.shot?.(this);
    if (shot) {
      const first = !this.looked;
      this.looked = true;
      // `nearYaw`, or a card asking for the corner on the far side of ±π sends
      // the shop the long way round — a full spin, once, on one card, which
      // reads as the camera having lost its place.
      if (first) this.scene?.aimView?.({ yaw: this.scene.nearYaw(shot.yaw), pitch: shot.pitch });
      if (Number.isFinite(shot.x)) this.hold(shot, first);
      return;
    }
    // ...and a card that wants one and cannot frame it yet gets no centre
    // either, or the view slides to the tile now and swings to the pose a frame
    // later, which is two camera moves for one card.
    if (this.step?.shot) return;
    const want = this.step?.at?.(this);
    const w = want && 'world' in want ? want.world : null;
    // A card that names no tile — a rail button, a panel, or a phase of a card
    // that has walked off the shop floor and onto the HUD — has to let the tile
    // GO, or the hold pins the view to whatever the last card was about for the
    // rest of the tour. The pan stays where it is: see `releaseHold`.
    if (!w || !Number.isFinite(w.x) || !Number.isFinite(w.z)) {
      this.scene?.releaseHold?.();
      return;
    }
    const first = !this.looked;
    this.looked = true;
    this.hold(w, first);
  }

  /**
   * Put the view on a tile, and KEEP it there for as long as the card lasts.
   *
   * The keeping is the whole of this, and it is the bug it was written for.
   * `camPan` is an offset off the body the camera follows, so a centre set once
   * is a centre that walks with you: the card points at a crate across the
   * yard, you walk to the crate, and the pan carries the framing the same
   * distance again — so you arrive at the thing the card is about with it in
   * the corner of the screen and half the frame on empty ground. It is worst on
   * exactly the cards that ask you to go somewhere, which is most of them.
   *
   * `scene.tourOwns` is how long "the card lasts" is measured, and it is not a
   * clock: it is true until a hand takes the view — a drag, `,`/`.`, or walking
   * somewhere yourself, which is `recentre`. So the camera holds the thing you
   * were pointed at, and the moment you disagree it is yours and stays yours.
   *
   * Slow on the first frame only. Re-seating is a fixed target being re-stated
   * rather than a new move, and asking for the tour's gains every frame would
   * hold the view on the slow ones for the whole card — which is the follow
   * being sluggish the moment you take it back.
   *
   * ...and the KEEPING is the renderer's now (`hold` on `focusOn`, `tourHold`
   * in client/render/scene.js), which is a fix rather than a tidy-up. This runs
   * on the snapshot and `camPan` is an offset off a body that is drawn every
   * frame, so re-stating it here was a centre that walked with you for a
   * hundred milliseconds and jumped back on the next packet — a 10Hz sawtooth
   * on the whole screen, and worst while walking, which is what every card
   * asking you to go somewhere is about. Still called every snapshot, because
   * the tile itself changes as a card's phases walk; what changed is that the
   * frames in between are no longer the tour's problem.
   */
  hold(at, first) {
    if (!first && !this.scene?.tourOwns) return;
    this.scene?.focusOn?.(at.x, at.z, { slow: first, hold: true });
  }

  /** Every snapshot. The predicate, and nothing else. */
  /**
   * KEEP the crew's tools down, rather than putting them down once.
   *
   * `crewIdle` is a field on the `Game`, deliberately not on the save — a tab
   * closed mid-tour must not come back to a shop whose staff have downed tools
   * for ever. Which means anything that builds a fresh `Game` starts it false:
   * a server restart, a room disposed after five idle minutes and reopened, a
   * world switched away from and back. The tour sends it once, on `start`, so
   * after any of those the hire quietly goes back to work in the middle of the
   * tour — and what you watch is the card asking you to go and pick up the
   * crate while a robot walks past you carrying it.
   *
   * Re-asserted rather than made durable, because the argument for it being
   * in-memory is the right one. Every few seconds is enough: the gap is bounded
   * by the interval rather than by how long the tour lasts, and it is one tiny
   * message against a snapshot ten times a second.
   */
  holdCrew() {
    if (this.guest || this.lesson) return;
    const now = performance.now();
    if (now - (this.heldAt ?? 0) < CREW_HOLD_MS) return;
    this.heldAt = now;
    this.net?.send('crew-idle', { idle: true });
  }

  update(state) {
    this.state = state;
    // The lessons are asked here rather than anywhere else, because "is there a
    // conveyor doing nothing" is a question about the snapshot and this is the
    // one place a snapshot lands. It returns immediately in every shop that
    // wants nothing, which is nearly every frame of nearly every shop.
    if (!this.on) { this.maybeLesson(); return; }
    if (!this.step) return;
    this.holdCrew();
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
             catalog row — see the art slot on a lesson step. Empty on all but
             one card of either tour, where the thing is standing in the shop
             with a green frame round it and a second picture of it would be a
             diagram of something you are looking at. The exception is the walk
             card, whose other half is the CAMERA — a gesture, which has nothing
             to stand anywhere — see dragArt. No backticks in here, for the
             reason the comment above gives. -->
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
          <!-- A KEY to marks the card has just named, one row each: the mark
               drawn at the size it reads at, and the sentence beside it. Under
               the words rather than in the picture well above, because the well
               is what the card is about and this is a footnote. Empty on every
               card but the one about the two green arrows. No backticks in
               here, for the reason the comments above give. -->
          <div class="tt-legend" hidden></div>
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
    // "Next" on the last card is a promise of another one, and what the press
    // actually does is end the tour — so the button says which. `go` past the
    // end is `quit`, so this is a label rather than a second path.
    next.textContent = this.i >= this.steps.length - 1 ? 'Done' : 'Next';
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
     *
     * THE ONE EXCEPTION IS A CONTROL (`mock`), and the exception is what proves
     * the rule rather than bending it. A piece's portrait is what the card is
     * about and holds still; a picture of a BUTTON is the other half of the
     * sentence, and the sentence on a two-phase step already walks — "open the
     * crew strip" becomes "click their tile" — so a picture that did not walk
     * with it would be a card naming one control and drawing another. It is
     * kept out of here for exactly that reason and painted by `mockAt`, off the
     * same `at` that decides where the mark goes, so the two can never disagree.
     */
    const art = this.el.querySelector('.tt-art');
    // A page names a KIND and the picture is derived, rather than each page
    // carrying its own `art` call: one place decides how a kind is drawn, so a
    // page cannot quietly get it wrong, and the same field answers whether the
    // thing is buildable yet.
    const svg = s.kind ? artOf(this, s.kind, s.piece)
      : (typeof s.art === 'function' ? s.art(this) : (s.art ?? null));
    // Kept, because `mockAt` borrows this slot for a control and has to be able
    // to hand it back — a step whose first phase is a rail button and whose
    // second is a piece off the palette is both pictures, one after the other.
    this.artHtml = svg ?? '';
    this.artSoon = !!svg && comingSoon(this, s.kind);
    this.mocked = null;
    art.hidden = !svg;
    art.innerHTML = this.artHtml;
    art.classList.toggle('soon', this.artSoon);
    // The key under the words, if this card has one. Here rather than in
    // `words` for the same reason the picture is: it is a fact about the card
    // rather than about the phase, and a block of rows that swapped under a
    // sentence you were reading would be a second thing to re-find.
    // Cleared rather than written, because the key under the words WALKS with
    // the sentence — see `words`. A card whose phases are a rail button, then a
    // palette tile, then a ghost on the floor has a key for the last of those
    // and none for the first two, and a legend written once at open would be
    // the one for the phase the card happened to start in. It is keyed on its
    // own markup there, so an unchanged block is not rewritten ten times a
    // second under a CSS animation that was already running.
    // `undefined` and NOT `null`, which is the whole of what makes this clear.
    // A card with no key computes `null`, so a cache reset to `null` compares
    // equal on the next frame and the previous card's rows are left standing in
    // the DOM — the shelf's two mouse rows sitting under a card about the crew,
    // which reads as the tutorial having lost its place. The sentinel means
    // "nothing has been written for this step yet", which is a third state.
    this.legendHtml = undefined;
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
    /**
     * The pop is for ARRIVING, and a step is not an arrival.
     *
     * It used to be restarted on every card, on the reasoning that a card after
     * the first would otherwise turn up already on screen. That is true and it
     * is what you want: the card never went anywhere. What the restart looked
     * like is the thing shutting and opening again between every beat — a flash
     * of nothing where the instruction was, ten times in one tour — because the
     * keyframe starts at `opacity: 0` and a fifth of a second is long enough to
     * read as a blink and too short to read as a transition.
     *
     * So it fires when the card is not on screen yet, which is the tour opening
     * and nothing else. Between steps the paper stays put and its contents
     * change under you, which is what a card of cards does.
     */
    if (!this.el.classList.contains('show')) {
      this.card.style.animation = 'none';
      void this.card.offsetWidth;
      this.card.style.animation = '';
    }
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
    // BEFORE the early return, and keyed on itself: the key under the words is
    // usually a fact about the same phase the sentence is, but nothing
    // guarantees it — a card whose words are a constant and whose legend is not
    // would never update, which is the shape of a bug nobody finds twice.
    const grew = this.legend();
    if (key === this.said) { if (grew) this.fits(); return; }
    this.said = key;
    const [kicker, say, hint] = now;
    this.el.querySelector('.tt-kicker').textContent = kicker;
    this.el.querySelector('.tt-say').innerHTML = keyed(say);
    this.el.querySelector('.tt-hint').innerHTML = keyed(hint);
    this.fits();
  }

  /**
   * The key under the words, which walks with them.
   *
   * Asked every frame with the sentence rather than once when the card opens,
   * because a step's phases are different subjects: the freezer beat is a rail
   * button, then a tile on the palette, then a ghost on the floor, and only the
   * last of those has three colours to explain. Written only when the markup
   * actually changes — this runs at 10Hz over a live canvas, and re-setting
   * `innerHTML` would restart the row animations under a reader.
   */
  legend() {
    const s = this.step;
    const rows = (typeof s?.legend === 'function' ? s.legend(this) : (s?.legend ?? null)) || null;
    if (rows === this.legendHtml) return false;
    this.legendHtml = rows;
    const el = this.el.querySelector('.tt-legend');
    el.hidden = !rows;
    el.innerHTML = rows ?? '';
    // Answers whether the card's HEIGHT just moved, so `words` can re-ask
    // `fits` on the frames where only this changed — a legend that appeared
    // under an unchanged sentence is exactly the case that turns the words
    // into a scroller.
    return true;
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
    // ...and the picture of whatever is being pointed at, which walks with the
    // sentence for the reason `paint` gives.
    this.mockAt(want?.mock ?? null);

    // The mark on the thing standing in the shop, laid in the shop.
    this.scene?.setTutorTarget?.(this.aim);

    // `soft` is a target the size of the whole world view. Ringing that is
    // drawing a box round the screen, which says nothing — the world mark above
    // is what is pointing at anything on those steps.
    //
    // ...and it LANDS a beat after the thing it is round, rather than with it —
    // see `markReady`. The node is handed over as null on every frame there is
    // nothing to ring, or a step that points into the shop and then back at the
    // bar would find its old stamp still standing and skip the beat.
    const at = box && !this.soft ? this.shown : null;
    const show = this.markReady('ring', at) ? box : null;
    this.ring.hidden = !show;
    if (show) {
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
    // The same beat the ring takes, and for the same reason twice over: this one
    // is a mark on a ROW of a panel the step has just opened, so without it the
    // button is pointed at before the list it is in has been seen at all.
    if (!this.markReady('pulse', t)) { el.hidden = true; return; }
    el.hidden = false;
    Object.assign(el.style, {
      top: `${Math.round(r.top - 3)}px`,
      left: `${Math.round(r.left - 3)}px`,
      width: `${Math.round(r.width + 6)}px`,
      height: `${Math.round(r.height + 6)}px`,
    });
  }

  /**
   * The picture of the control the card is naming — see `mockOf`.
   *
   * Keyed on the selector so the clone happens when the phase changes and not
   * ten times a second, and so an unchanged mock is not re-written into the
   * document under a CSS animation that was already running.
   *
   * The SCALE is the half that could not be done in the stylesheet. A rail
   * button is 40px and a crew tile about 110, both of them multiplied by the
   * player's own HUD dial, against a well that is a fixed 168 — so a number
   * typed into the CSS would be right for one control at one setting. It is
   * measured off the clone and the well, capped, and never allowed to shrink
   * something that already fits: a picture of a button smaller than the button
   * is a picture of a different button.
   *
   * A missing target is NOT a lost step — that is `holeFor`'s job, and this is a
   * picture. A frame where the strip has not rendered yet hands the well back to
   * whatever the step's own art was, which is nothing on most of these cards.
   */
  mockAt(sel) {
    if (sel === this.mocked) return;
    const art = this.el.querySelector('.tt-art');
    const html = sel ? mockOf(sel) : null;
    if (!html) {
      // Only give the well back once, or a step with no art at all re-writes an
      // empty string into it on every frame the control is missing.
      if (this.mocked === null) return;
      this.mocked = null;
      art.hidden = !this.artHtml;
      art.innerHTML = this.artHtml;
      art.classList.toggle('soon', this.artSoon);
      return;
    }
    this.mocked = sel;
    art.hidden = false;
    art.classList.remove('soon');
    art.innerHTML = `<div class="tt-mock">${html}</div>`;
    const box = art.querySelector('.tt-mock');
    const r = box.firstElementChild?.getBoundingClientRect();
    const well = art.getBoundingClientRect();
    if (!r?.width || !r?.height || !well.width) return;
    const k = Math.min((well.width - 28) / r.width, (well.height - 28) / r.height, 2.6);
    if (k > 1) box.style.transform = `scale(${k.toFixed(3)})`;
  }

  /**
   * Has this mark's target been standing there long enough to be marked?
   *
   * The mark used to land on the same frame as the thing it points at, which is
   * one thing happening rather than two: a step `arm`s the crew strip open and
   * the ring is already round a row of it before the panel has been read as a
   * panel. `MARK_WAIT_MS` is the beat, and the fade is in the CSS — the mark is
   * `display: none` while it waits, so unhiding it restarts `ttmark-in`.
   *
   * Keyed on the NODE, which is what makes it a beat rather than a blink. The
   * rect moves constantly — a scrolled list, a resized window, a panel that
   * repainted — and none of those is the target arriving, so a key on the
   * geometry would hold the mark off for as long as anybody was scrolling.
   * A node going away and coming back IS an arrival, and comes back as a new
   * node, since the panels rebuild from `innerHTML`.
   *
   * The timer is the half that is not obvious: `place` runs on the snapshot,
   * so a target found on the tick a card opens would otherwise wait for the
   * NEXT snapshot to be shown, and a lesson browsed with the shop paused would
   * wait for ever. It is one timer for both marks because `place` re-asks for
   * both whatever woke it.
   */
  markReady(slot, node) {
    const seen = (this.marks ??= {});
    if (!node) { seen[slot] = null; return false; }
    const was = seen[slot];
    if (was?.el === node) return Date.now() - was.at >= MARK_WAIT_MS;
    seen[slot] = { el: node, at: Date.now() };
    clearTimeout(this.markTimer);
    this.markTimer = setTimeout(() => this.place(), MARK_WAIT_MS + 20);
    return false;
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
        // Same label `paint` chose, or a card that stranded and recovered on
        // the last beat comes back saying "Next" about a press that finishes.
        btn.textContent = this.i >= this.steps.length - 1 ? 'Done' : 'Next';
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
    // A want that names NEITHER is the same as no want at all, and it is a real
    // shape rather than a mistake: `at` is also where a card says which control
    // its picture is of (`mock`), and the beat about the emote strip has a
    // picture and a keypress and nothing anywhere to draw a frame round. Handled
    // here or it falls to the bottom of this function, finds no element and sets
    // `lost` — which is the card growing a "Carry on" button six seconds into a
    // step that is working perfectly.
    if (!want || (!want.el && !('world' in want))) {
      this.aim = null; this.lost = false; this.soft = false; return null;
    }
    const pad = want.pad ?? 4;

    if ('world' in want) {
      // A point in the shop, handed to the renderer to mark in the shop — see
      // the header for why it is not a rectangle on the page. The height is
      // still each target's own and is now what the chevron floats at rather
      // than where the mark is drawn — see `Scene.setTutorTarget`.
      this.aim = want.world
        ? { x: want.world.x, z: want.world.z, y: want.y ?? 0.8, fixture: want.fixture ?? null }
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
