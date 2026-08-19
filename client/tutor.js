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
const STEPS = [
  {
    id: 'hello',
    kicker: 'New shop',
    say: 'Morning. I am the fitter — I get shops open.',
    hint: 'Six or seven minutes and you will know where everything is. '
      + 'You can leave at any point; the button is bottom-right of this card.',
    big: true,
  },

  {
    id: 'walk',
    kicker: 'Getting about',
    say: 'Tap the floor over there. You will walk to it.',
    hint: 'Tapping a thing walks you to it AND does the obvious thing when you '
      + 'arrive — that one press is most of the game.',
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
    id: 'look',
    kicker: 'The camera',
    say: 'Now swing the view round. Right button, and drag.',
    hint: 'Scroll zooms. The , and . keys turn a quarter at a time. '
      + 'The camera stays where you put it until you walk somewhere.',
    at: () => ({ el: '#game', soft: true }),
    watch: 'camera',
    done(t) { return t.camMoved; },
  },

  {
    id: 'order',
    kicker: 'Stock',
    say: 'Nothing to sell yet. Open the supplier.',
    hint: 'Everything the shop sells is bought in, grown out the back, or made '
      + 'on a machine. This is the buying half.',
    at: () => ({ el: '[data-rail="stock"]' }),
    done(t) { return t.ui.openPanel === 'stock'; },
  },

  {
    id: 'buy',
    kicker: 'Stock',
    say: 'Buy a case of something cheap.',
    hint: 'It goes on a van and turns up at the bay out the back. '
      + 'Vans run on the hour, so it will not be long.',
    at: () => ({ el: '#panel' }),
    done(t) { return (t.state?.orders?.pending ?? []).length > 0 || t.crateSeen; },
  },

  {
    id: 'hire',
    kicker: 'The crew',
    say: 'While that drives over — take somebody on.',
    hint: 'Everyone who works here is a machine. This is the roster, and the '
      + 'last tab on it is who you can put on lease.',
    at: () => ({ el: '[data-rail="staff"]' }),
    done(t) { return t.ui.bar === 'staff'; },
  },

  {
    id: 'clerk',
    kicker: 'The crew',
    say: 'Take on a Clerk. Press it twice — the second press confirms.',
    hint: (t) => {
      const row = (t.ui.catalog?.workers ?? []).find((w) => /clerk/i.test(w.id));
      return row
        ? `${money(row.cost)} up front and a lease every morning. A clerk works the till, `
          + 'which is the one job the shop cannot do without.'
        : 'A clerk works the till, which is the one job the shop cannot do without.';
    },
    at: (t) => {
      const row = (t.ui.catalog?.workers ?? []).find((w) => /clerk/i.test(w.id));
      return { el: row ? `[data-entry="kind:${row.id}"]` : null, pad: 6 };
    },
    // Which TAB, as well as which strip. `staffGroups` files who works here
    // under one tab per kind and who you could take on under `hire`, so a tile
    // lit without this is a tile in a tab you are not looking at — which
    // `holeFor` reads as lost and steps aside for, correctly and uselessly.
    arm(t) { t.ui.showBar('staff'); t.ui.barTab.staff = 'hire'; t.ui.renderHotbar(); },
    done(t) { return (t.state?.roster ?? []).length > 0; },
  },

  {
    id: 'roster',
    kicker: 'The crew',
    say: 'Open them up — press their tile on the strip.',
    hint: 'A hire has a shift you set: what they spend the day doing, and how '
      + 'much of it goes on each thing.',
    at: (t) => {
      const who = (t.state?.roster ?? [])[0];
      return { el: who ? `[data-entry="hire:${who.id}"]` : null, pad: 6 };
    },
    arm(t) { t.ui.showBar('staff'); t.ui.barTab.staff = 'all'; t.ui.renderHotbar(); },
    done(t) { return t.ui.openPanel === 'worker'; },
  },

  {
    id: 'jobs',
    kicker: 'The crew',
    say: 'Put more of their day on the till. Press + on Serve.',
    hint: 'The numbers are a ratio and a budget at the same time — you cannot '
      + 'max everything, and a rung of firmware buys more of the day to spend.',
    // The stepper, not the + on its own. `+` goes `disabled` the moment the
    // shift is full — so a hole cut round it is a hole round a dead button,
    // with the − that would make room for it out in the blackout.
    at: () => ({ el: '[data-job="serve"]', up: '.wk-job', pad: 8 }),
    start(t) { this.from = t.jobSig(); },
    done(t) { return this.from !== null && t.jobSig() !== this.from; },
  },

  {
    id: 'build',
    kicker: 'Building',
    say: 'Now put something up. Open build mode.',
    hint: 'Press it once for the mode — that is the one you rearrange in — and '
      + 'again for the catalogue.',
    at: () => ({ el: '[data-rail="build"]' }),
    arm(t) { t.ui.closePanel?.(); },
    done(t) { return t.ui.bar === 'build'; },
  },

  {
    id: 'freezer',
    kicker: 'Building',
    say: (t) => `Pick the ${cheapestFreezer(t)?.name ?? 'chiller'} out of the Shop tab.`,
    hint: 'Frozen goods rot on an ordinary shelf and keep in here. A hot counter '
      + 'is a third thing again — being in the wrong one is no better than being '
      + 'in none.',
    at: (t) => {
      const p = cheapestFreezer(t);
      return { el: p ? `[data-entry="${p.id}"]` : null, pad: 6 };
    },
    arm(t) {
      t.ui.showBar('build');
      t.ui.selectBuildGroup?.('shop');
    },
    done(t) { return t.ui.toolId?.() === cheapestFreezer(t)?.id; },
  },

  {
    id: 'place',
    kicker: 'Building',
    say: 'Tap a bit of floor to stand it there.',
    hint: 'Green means it fits. Amber means it fits and will cost you something '
      + '— a walled-in shelf, a queue with nowhere to go — and the shop lets you, '
      + 'because blocking your own aisle is a move.',
    at: () => ({ el: '#game', soft: true }),
    start(t) { this.from = shelvesOf(t, 'freezer').length; },
    done(t) { return this.from !== null && shelvesOf(t, 'freezer').length > this.from; },
  },

  {
    id: 'van',
    kicker: 'Stock',
    say: 'That is the shop. Now the goods — here comes the van.',
    hint: 'Crates land on the painted pad out the back. Everything the shop ever '
      + 'puts on the floor is one of these.',
    hold: true,
    arm(t) { t.ui.toggleBuild?.(false, { quiet: true }); t.ui.showBar(null); },
    at: (t) => ({ world: nearestCrate(t) }),
    done(t) { return !!nearestCrate(t); },
  },

  {
    id: 'take-one',
    kicker: 'Stock',
    say: 'Tap the crate. One tap takes one unit.',
    hint: 'A tap is one, a hold is the lot. That sentence is true of everything '
      + 'in the shop that holds goods.',
    at: (t) => ({ world: nearestCrate(t) }),
    done(t) { return lotSize(meOf(t)?.carry) > 0; },
  },

  {
    id: 'shelve-one',
    kicker: 'Stock',
    say: 'Put it on a shelf. Tap the shelf with it in your hands.',
    hint: 'The units that will take what you are holding light up on their own '
      + 'while your hands are full.',
    at: (t) => ({ world: anyShelf(t) }),
    done(t) { return lotSize(meOf(t)?.carry) === 0; },
  },

  {
    id: 'haul',
    kicker: 'Stock',
    say: 'One at a time is slow. Hold the press on the crate to shoulder it.',
    hint: 'A box holds more than a pair of hands, so carrying it is the trip '
      + 'worth making. Hold, and watch the ring go round.',
    at: (t) => ({ world: nearestCrate(t) }),
    done(t) { return !!meOf(t)?.haul; },
    // Nothing left on the floor to lift is not a failure — you may well have
    // shelved the lot by hand. The tour steps over it rather than standing there
    // pointing at a bay with nothing on it.
    skipWhen(t) { return !nearestCrate(t) && !meOf(t)?.haul; },
  },

  {
    id: 'pour',
    kicker: 'Stock',
    say: 'Now tip it in. Hold the press on a shelf.',
    hint: 'It fills board by board and stops at what fits. A right press does '
      + 'the same thing the other way round — put ONE back.',
    at: (t) => ({ world: anyShelf(t) }),
    done(t) { return !meOf(t)?.haul; },
    skipWhen(t) { return !meOf(t)?.haul; },
  },

  {
    id: 'open',
    kicker: 'Opening up',
    say: 'Last thing. Raise the shutters.',
    hint: 'The shop starts shut so you can lay it out in peace. This is the '
      + 'switch that lets the town in.',
    at: () => ({ el: '#sign', pad: 8 }),
    done(t) { return t.state?.shutters === true; },
  },

  {
    id: 'bye',
    kicker: 'Open',
    say: 'That is the shop. The rest is yours.',
    hint: 'Everything I showed you has a key — press / for the list, and the '
      + 'Milestones panel is the ladder up. Good luck.',
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
      <div class="tt-aim" hidden><i></i><i></i></div>
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

  paint() {
    const s = this.step;
    if (!s) return;
    const said = (v) => (typeof v === 'function' ? v(this) : v);
    this.el.querySelector('.tt-kicker').textContent = said(s.kicker) ?? '';
    this.el.querySelector('.tt-say').textContent = said(s.say) ?? '';
    this.el.querySelector('.tt-hint').textContent = said(s.hint) ?? '';
    // A step with no predicate is a thing to read, so it gets a button. One with
    // a predicate must not have one — a Next beside "tap the floor" is an offer
    // to not learn the only thing on the card.
    const next = this.el.querySelector('.tt-next');
    delete next.dataset.stranded;
    this.lostAt = 0;
    next.textContent = 'Next';
    next.hidden = !!s.done;
    this.card.classList.toggle('big', !!s.big);
    this.card.classList.toggle('holding', !!s.hold);
    // Where you are, as ticks rather than "4 of 18" — a count invites you to
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
   * Measure the hole and put the four blockers round it.
   *
   * Everything in here is in CSS pixels off `getBoundingClientRect`, so it
   * survives a resize, a scrolled panel and a bar that changed height — none of
   * which the tour is told about, and all of which move the thing it is pointing
   * at.
   */
  place() {
    if (!this.on || !this.step) return;
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
    if (!this.lost) {
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
      const p = want.world
        ? this.scene?.worldToScreen?.(want.world.x, want.world.z, 1.1) ?? null
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
    const gap = 18;

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
