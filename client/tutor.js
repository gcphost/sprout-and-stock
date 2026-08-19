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
 * **The veil is four boxes, not a hole punched in one.** A `clip-path` with a
 * gap in it still swallows the pointer over the gap in Safari, and a veil with
 * `pointer-events: none` blacks out without muting — which is the half that
 * matters, since the whole promise is that the wrong button cannot be pressed.
 * Four blockers round a rectangle means the hole is a genuine absence, and the
 * press that goes through it is the ordinary press the game already handles.
 *
 * **It refuses to block the world.** Every step whose target is a thing standing
 * in the shop — a crate, a shelf, the tile you walk to — lights the canvas
 * whole and drops a pulsing ring on the target instead, pinned through
 * `Scene.worldToScreen` every frame. Two reasons it is not a rectangle. A shelf
 * is a three-quarter-tile box drawn most of a tile up-screen of the ground it
 * stands on, so a box round where the pointer *ought* to go is a box in the
 * wrong place — see `pickFixture` for the same trap said about aiming. And a
 * crate is not a fixture, so the renderer's own marker (`setMarkedSet`, which
 * wants an `f`) has nothing to hang on: one ring in screen space answers for
 * both, and for the tile you are being asked to walk to, which is neither.
 *
 * The one thing it may never do is trap you. Skip is on every step, Esc skips,
 * and the whole thing can be switched off from the Menu — which is also where
 * you switch it back on, because a tutorial you cannot re-run is a tutorial that
 * punishes the first press.
 */

import { money } from './money.js';

/** Off for everybody, everywhere. The Menu's switch. */
const OFF_KEY = 'sns-tutor-off';
/** Worlds this browser has finished (or skipped) the tour in. */
const DONE_KEY = 'sns-tutor-done';
/** Worlds this browser MADE, and so believes are new. */
const NEW_KEY = 'sns-tutor-new';

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
 * morning and came back to — and being handed the tour again on a shop you have
 * already furnished is the thing that makes people turn tutorials off.
 */
export const markWorldNew = (id) => addTo(NEW_KEY, id);

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

/** Every unit of shelving standing in the shop, by kind. */
const shelvesOf = (t, kind = null) => (t.state?.shelves ?? [])
  .filter((s) => !kind || s.kind === kind);

/** The nearest crate of stock on the floor — the one the marker should point at. */
function nearestCrate(t) {
  const me = meOf(t);
  const crates = (t.state?.deliveries ?? []).filter((d) => !d.rubbish && lotSize(d) > 0);
  if (!crates.length) return null;
  if (!me) return crates[0];
  return crates.slice().sort((a, b) => dist(a, me) - dist(b, me))[0];
}

/** A shelf with room on it, preferring one that is already carrying something. */
function anyShelf(t) {
  const units = shelvesOf(t, 'shelf');
  return units.find((s) => (s.stacks ?? []).length) ?? units[0] ?? null;
}

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
/** The Clerk kind, which is the one the tour takes on. */
const clerkKind = (t) => (t.ui.catalog?.workers ?? []).find((w) => /clerk/i.test(w.id)) ?? null;

/**
 * The tour, in order. TEN beats, and the count is the design.
 *
 * It was eighteen, one card per press, and eighteen cards is a lecture — you
 * stop reading at about the fifth and start hunting for Skip. The saving is not
 * in cutting what it teaches: it teaches the same ten things. It is that a step
 * **moves its own spotlight**. `at` and `say` are asked every frame, so "open the
 * crew strip, then press the Clerk on it" is one card whose hole walks from the
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
    say: 'Morning. I fit shops out — give me five minutes.',
    hint: 'Stock on the shelves, somebody behind the till, and the doors open. '
      + 'Skip is bottom right of this card and it is on every one of them.',
    big: true,
  },

  {
    id: 'walk',
    kicker: 'Getting about',
    say: 'Click a bit of floor. You walk to it.',
    // Both halves of the mouse, because a press that MOVED is never a walk —
    // and the camera is the thing a new player reaches for first and finds by
    // accident. Either button drags the view; which one decides whether it
    // slides or swings.
    hint: 'Drag instead of clicking and you move the CAMERA — left slides it '
      + 'across, right swings it round and tilts. Let go without moving and it '
      + 'counts as a click again. WASD walks you by hand, and the view stays '
      + 'wherever you left it until you go somewhere.',
    at: () => ({ el: '#game', soft: true }),
    start(t) { this.from = meOf(t) ? { ...meOf(t) } : null; },
    done(t) {
      const me = meOf(t);
      if (!me) return false;
      if (!this.from) { this.from = { ...me }; return false; }
      return dist(me, this.from) > 2.5;
    },
  },

  {
    id: 'stock',
    kicker: 'Buying in',
    say: (t) => (t.ui.openPanel === 'stock'
      ? 'Buy a case of something cheap.'
      : 'Nothing to sell yet. Open the supplier.'),
    hint: (t) => (t.ui.openPanel === 'stock'
      ? 'It does not appear on a shelf. It goes on a lorry and gets dropped at '
        + 'the pad behind the shop, and somebody has to carry it in. That '
        + 'somebody is you, until you hire a stocker.'
      : 'Everything you sell is bought in here, grown in the beds out the side, '
        + 'or made on a machine.'),
    at: (t) => (t.ui.openPanel === 'stock'
      ? { el: '#panel' }
      : { el: '[data-rail="stock"]' }),
    done(t) { return (t.state?.orders?.pending ?? []).length > 0 || t.crateSeen; },
  },

  {
    id: 'hire',
    kicker: 'The crew',
    say: (t) => (t.ui.bar === 'staff'
      ? 'Click the Clerk twice. The second click is the confirm.'
      : 'While that drives over — open the crew strip.'),
    hint: (t) => {
      const row = clerkKind(t);
      return t.ui.bar === 'staff'
        ? `${row ? `${money(row.cost)} now, ` : ''}and a lease off the till every `
          + 'morning whether they earn it or not. A clerk stands at the checkout '
          + 'and serves. Nobody on the till means nobody pays, and shoppers walk '
          + 'out with a full basket.'
        : 'Everybody who works here is a machine you lease. There is no one to '
          + 'hire from — you pick a kind, and it turns up.';
    },
    at: (t) => {
      if (t.ui.bar !== 'staff') return { el: '[data-rail="staff"]' };
      const row = clerkKind(t);
      return { el: row ? `[data-entry="kind:${row.id}"]` : null, pad: 6 };
    },
    arm(t) { t.ui.closePanel?.(); },
    // The strip files who works here under one tab per kind and who you could
    // take on under `hire`, so the tile is only in the document while that tab
    // is open. Held rather than set once, because a step whose hole is a tab
    // away is a step that reads as pointing at nothing.
    nudge(t) {
      if (t.ui.bar !== 'staff' || t.ui.barTab.staff === 'hire') return;
      t.ui.barTab.staff = 'hire';
      t.ui.renderHotbar();
    },
    done(t) { return (t.state?.roster ?? []).length > 0; },
  },

  {
    id: 'shift',
    kicker: 'The crew',
    say: (t) => (t.ui.openPanel === 'worker'
      ? 'Move a point around. Take one off a job they will not be doing.'
      : 'Open them up — click their tile on the strip.'),
    hint: (t) => (t.ui.openPanel === 'worker'
      ? 'This is a budget, not a set of dials. The total is capped until you pay '
        + 'for a rung of firmware, so a point on one job is a point off another '
        + '— and a job at its ceiling has a dead +, which is the cap telling you '
        + 'so. A clerk who never touches a bed is points you are not spending.'
      : 'A hire is not fixed. You set what they spend the day on: the till, '
        + 'putting stock out, sweeping up, the beds.'),
    // The whole list, never the Serve `+`. That button goes dead the moment the
    // shift is full — which on a fresh clerk it usually already is — so a hole
    // cut round it is a hole round a button that cannot be pressed, with the
    // `−` that would make room for it out in the blackout. The lesson was never
    // "press +", it is "these numbers come out of one another".
    at: (t) => {
      if (t.ui.openPanel === 'worker') return { el: '.wk-jobs', pad: 8 };
      const who = (t.state?.roster ?? [])[0];
      return { el: who ? `[data-entry="hire:${who.id}"]` : null, pad: 6 };
    },
    arm(t) { t.ui.showBar('staff'); t.ui.barTab.staff = 'all'; t.ui.renderHotbar(); },
    // Self-healing rather than armed-once: close the sheet and the hole walks
    // back to the tile, which only exists while the strip is up.
    nudge(t) {
      if (t.ui.openPanel === 'worker' || t.ui.bar === 'staff') return;
      t.ui.showBar('staff');
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
      const p = cheapestFreezer(t);
      if (t.ui.toolId?.() !== p?.id) return `Pick the ${p?.name ?? 'chiller'} out of the Shop tab.`;
      return 'Click a bit of floor to stand it there.';
    },
    hint: (t) => {
      const p = cheapestFreezer(t);
      if (t.ui.toolId?.() !== p?.id) {
        return `${p ? `${money(p.cost)}. ` : ''}Anything tagged frozen goes off on `
          + 'an ordinary shelf and keeps in here — stock that rots is money you '
          + 'already spent. (I opened this for you: the Build button is one press '
          + 'for the mode, two for the catalogue.)';
      }
      return 'Green means it fits. Amber means it fits and will cost you '
        + 'something — a shelf walled in, a queue with nowhere to stand — and the '
        + 'shop lets you anyway, because blocking your own aisle is a decision.';
    },
    at: (t) => {
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
    nudge(t) {
      if (t.ui.bar !== 'build') { t.ui.pressBuild(); return; }
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
    say: (t) => (nearestCrate(t)
      ? 'Click the crate. One click takes one unit out.'
      : 'Van is on its way. Crates get left on the pad round the back.'),
    // The four presses, said once, in the one place the player is holding the
    // mouse over the thing they are about. This is the sentence the whole tour
    // exists to deliver — everything else is scaffolding round it.
    hint: 'Here the two buttons mean opposite things, and it is the same four '
      + 'presses on every crate, shelf and machine in the shop. LEFT takes one. '
      + 'HOLD LEFT takes the lot. RIGHT puts one back. HOLD RIGHT pours in '
      + 'everything you are carrying.',
    arm(t) { t.ui.toggleBuild?.(false, { quiet: true }); t.ui.showBar(null); },
    at: (t) => ({ world: nearestCrate(t), y: CRATE_Y }),
    // Nobody's fault and nothing to press. Without this the card reads as an
    // instruction you are failing, and the stranded-timer offers to skip the
    // one beat the whole tour is building up to.
    waiting(t) { return !nearestCrate(t); },
    done(t) { return lotSize(meOf(t)?.carry) > 0; },
  },

  {
    id: 'shelve-one',
    kicker: 'Stock',
    say: 'Now click a shelf. It goes on.',
    hint: 'Chevrons appear over every unit that would take what you are holding, '
      + 'the moment your hands are full — so you never have to remember which '
      + 'shelf is for what. A shelf with no chevron will refuse you.',
    at: (t) => ({ world: anyShelf(t), y: SHELF_Y }),
    done(t) { return lotSize(meOf(t)?.carry) === 0; },
  },

  {
    id: 'crate',
    kicker: 'Stock',
    say: (t) => (meOf(t)?.haul
      ? 'Now HOLD the left button on a shelf to tip the box in.'
      : 'One at a time is a long afternoon. HOLD the left button on the crate.'),
    hint: (t) => (meOf(t)?.haul
      ? 'It goes on board by board and stops when the shelf is full — whatever '
        + 'is left stays in the box on your shoulder. Holding the RIGHT button '
        + 'over a shelf does the same job from your hands.'
      : 'Hold it and a ring winds round the crate. Let go early and nothing '
        + 'happens. Let it finish and the whole box goes up on your shoulder — '
        + 'which carries far more than your arms do, and is the only reason the '
        + 'walk across the shop is worth making.'),
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
    id: 'open',
    kicker: 'Opening up',
    say: 'Last thing. Click the sign to raise the shutters.',
    hint: 'The shop starts shut so you can lay it out with nobody in it. Press '
      + 'this and the town starts arriving — and everything you just did starts '
      + 'earning or costing. Good luck.',
    at: () => ({ el: '#sign', pad: 8 }),
    done(t) { return t.state?.shutters === true; },
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
    if (!this.world || tutorOff()) return;
    if (listOf(DONE_KEY).includes(this.world)) return;
    if (!listOf(NEW_KEY).includes(this.world)) return;
    this.start();
  }

  start() {
    this.on = true;
    this.i = -1;
    this.camMoved = false;
    this.crateSeen = false;
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
    this.el.hidden = true;
    this.el.classList.remove('show');
    document.body.classList.remove('tutoring');
    if (this.world) { addTo(DONE_KEY, this.world); dropFrom(NEW_KEY, this.world); }
    if (why === 'done') this.ui.toast('Tour finished — press / for the key list');
  }

  // -- the script -----------------------------------------------------------

  go(i) {
    if (i >= STEPS.length) { this.quit('done'); return; }
    this.i = i;
    this.step = STEPS[i];
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
      <div class="tt-veil tt-n"></div><div class="tt-veil tt-s"></div>
      <div class="tt-veil tt-w"></div><div class="tt-veil tt-e"></div>
      <div class="tt-ring" hidden></div>
      <div class="tt-aim" hidden><i></i><i></i><b></b></div>
      <div class="tt-card">
        <div class="tt-bot">${FACE}</div>
        <div class="tt-said">
          <div class="tt-kicker"></div>
          <p class="tt-say"></p>
          <p class="tt-hint"></p>
        </div>
        <div class="tt-feet">
          <div class="tt-dots"></div>
          <button class="tt-next" type="button" hidden>Next</button>
          <button class="tt-skip" type="button">Skip the tour</button>
        </div>
      </div>`;
    this.card = this.el.querySelector('.tt-card');
    this.ring = this.el.querySelector('.tt-ring');
    this.aimEl = this.el.querySelector('.tt-aim');
    this.el.querySelector('.tt-skip').onclick = () => this.quit('skipped');
    this.el.querySelector('.tt-next').onclick = () => this.next();
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
    this.card.classList.toggle('big', !!s.big);
    this.said = null;
    this.words();
    // Where you are, as ticks rather than "4 of 10" — a count invites you to
    // work out how much is left, which is not the question the card wants asked.
    this.el.querySelector('.tt-dots').innerHTML = STEPS
      .map((_, i) => `<i class="${i < this.i ? 'was' : ''}${i === this.i ? ' at' : ''}"></i>`)
      .join('');
    // Restart the pop, or every card after the first arrives already on screen.
    this.card.style.animation = 'none';
    void this.card.offsetWidth;
    this.card.style.animation = '';
    this.el.classList.add('show');
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
   * Measure the hole and put the four blockers round it.
   *
   * Everything in here is in CSS pixels off `getBoundingClientRect`, so it
   * survives a resize, a scrolled panel and a bar that changed height — none of
   * which the tour is told about, and all of which move the thing it is pointing
   * at.
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

    const W = window.innerWidth;
    const H = window.innerHeight;
    const el = (sel) => this.el.querySelector(sel);

    // The ring on the thing in the shop. Behind the veil in z-order rather than
    // in front of it, so a target that has walked off the lit area — a crate
    // somebody else picked up — dims with everything else instead of glowing
    // over the top of a blackout.
    this.aimEl.hidden = !this.aim;
    if (this.aim) {
      this.aimEl.style.left = `${Math.round(this.aim.x)}px`;
      this.aimEl.style.top = `${Math.round(this.aim.y)}px`;
    }

    if (!box) {
      // Either the veil covers everything (a card that is read, not acted on)
      // or it covers nothing (`lost` — we do not know what to light, so we get
      // out of the way). Same branch, opposite sizes, because both end with the
      // card in the middle and no ring anywhere.
      const full = this.lost ? 0 : H;
      Object.assign(el('.tt-n').style, { top: '0px', left: '0px', width: `${W}px`, height: `${full}px` });
      for (const q of ['.tt-s', '.tt-w', '.tt-e']) {
        Object.assign(el(q).style, { width: '0px', height: '0px' });
      }
      this.ring.hidden = true;
      this.card.classList.remove('pinned');
      this.card.style.left = '';
      this.card.style.top = '';
      this.strand();
      return;
    }
    this.strand();

    const { x, y, w, h } = box;
    Object.assign(el('.tt-n').style, { top: '0px', left: '0px', width: `${W}px`, height: `${Math.max(0, y)}px` });
    Object.assign(el('.tt-s').style, { top: `${y + h}px`, left: '0px', width: `${W}px`, height: `${Math.max(0, H - y - h)}px` });
    Object.assign(el('.tt-w').style, { top: `${y}px`, left: '0px', width: `${Math.max(0, x)}px`, height: `${h}px` });
    Object.assign(el('.tt-e').style, { top: `${y}px`, left: `${x + w}px`, width: `${Math.max(0, W - x - w)}px`, height: `${h}px` });

    // `soft` is a hole the size of the whole world view. Ringing that is drawing
    // a box round the screen, which says nothing and hides the marker in it.
    this.ring.hidden = this.soft;
    if (!this.soft) {
      Object.assign(this.ring.style, {
        top: `${y}px`, left: `${x}px`, width: `${w}px`, height: `${h}px`,
      });
    }

    this.pin(box);
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
    if (!want) { this.aim = null; this.lost = false; this.soft = false; return null; }
    const pad = want.pad ?? 4;

    if ('world' in want) {
      // A point in the shop. The card is pinned beside where it projects to and
      // the hole is the canvas — see the header for why a rectangle round a
      // fixture is a rectangle in the wrong place.
      // The height matters more than it looks. `worldToScreen` takes one, and on
      // a 45° camera a metre of height is most of a tile of SCREEN — up and to
      // the right. So a crate marked at head height gets a ring hanging in the
      // air off its top corner, which reads as the mark being broken rather
      // than as the wrong number: everything about it is correct except which
      // y it was asked about. Each target says its own — a box on the floor is
      // low, a shelf is marked at its boards.
      const p = want.world
        ? this.scene?.worldToScreen?.(want.world.x, want.world.z, want.y ?? 0.8) ?? null
        : null;
      this.aim = p && Number.isFinite(p.x) ? { x: p.x, y: p.y } : null;
      this.lost = !want.world;
      // A world target is always `soft`: the hole is the whole canvas, so the
      // ring would be a box round the screen and the card would pin to a corner
      // of it. The ring on the thing itself and the card beside where it
      // projects are the two halves the flag switches on.
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
    const r = t?.getBoundingClientRect();
    if (!r?.width || !r?.height) { this.lost = true; return null; }
    this.lost = false;
    return { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
  }

  /**
   * Put the card beside the hole, on whichever side has room for it.
   *
   * The card is what tells you what the lit thing is FOR, so a card that covers
   * the lit thing is the one arrangement that cannot work. It is measured rather
   * than placed by rule: the rail is up the right-hand side, the bar is across
   * the bottom and the panel is in the middle, so no single side is free for
   * every step.
   */
  pin(box) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cw = this.card.offsetWidth || 340;
    const ch = this.card.offsetHeight || 190;
    // Clearance, not politeness. A world mark is a ring about 70px across
    // CENTRED on the point, so a card set 18px off the point lands on top of
    // the bottom of the ring and half of what it is ringing. The gap has to
    // clear the mark's own radius before it starts being a gap at all.
    const gap = this.aim ? 64 : 20;

    // A world step aims at the projected point rather than at the hole, which is
    // the whole canvas — pinning to that would put the card in a corner of the
    // screen with nothing to do with where you are being pointed.
    const at = this.aim ? { x: this.aim.x, y: this.aim.y, w: 0, h: 0 } : box;

    const room = {
      below: H - (at.y + at.h) - gap,
      above: at.y - gap,
      right: W - (at.x + at.w) - gap,
      left: at.x - gap,
    };

    let left;
    let top;
    if (room.below >= ch) { top = at.y + at.h + gap; left = at.x + at.w / 2 - cw / 2; }
    else if (room.above >= ch) { top = at.y - ch - gap; left = at.x + at.w / 2 - cw / 2; }
    else if (room.left >= cw) { left = at.x - cw - gap; top = at.y + at.h / 2 - ch / 2; }
    else if (room.right >= cw) { left = at.x + at.w + gap; top = at.y + at.h / 2 - ch / 2; }
    else {
      // Nowhere beside it. Whichever half of the screen the target is NOT in,
      // which is the last honest answer before overlapping the thing being
      // pointed at.
      top = at.y > H / 2 ? gap : H - ch - gap;
      left = W / 2 - cw / 2;
    }

    this.card.classList.add('pinned');
    this.card.style.left = `${Math.round(Math.min(W - cw - 8, Math.max(8, left)))}px`;
    this.card.style.top = `${Math.round(Math.min(H - ch - 8, Math.max(8, top)))}px`;
  }
}
