/**
 * HUD and menus.
 *
 * Plain DOM over the canvas — no framework. Everything is driven from the
 * server snapshot, so the UI automatically shows content that was added live
 * without a page reload.
 */

import { variantsOf } from '../shared/model.js';
import { fixtureLabel, pieceFor, kindOf, openOf } from '../shared/pieces.js';
import { spotsOf } from '../shared/build.js';
import { lotStacks, lotTotal, lotQty } from '../shared/lot.js';
import { clockLabel, weekdayLabel } from '../shared/clock.js';
import { pillDrives } from './input.js';
import {
  buildTools, buildGroups, groupOfTool, subOfTool, sectionById, staffGroups,
} from './sections.js';
import { renderBar, groupAt, nextGroup, KEYED } from './bar.js';
import { deptsIn, deptStrip, inDept, wireDepts } from './aisles.js';
import { setHtml } from './paint.js';
import { wireScroll } from './scroll.js';
// ...and the window it gives Let go, because taking somebody on is the same
// irreversible decision pointed the other way and two different waits for one
// kind of confirm is a UI you have to learn twice. See `armHire`.
import { showWorker, ARM_MS } from './worker-menu.js';
import { Rail } from './rail.js';
import { tip } from './tip.js';
import { ICONS } from './icons.js';
import { showFixture, ONE_AT_A_TIME } from './fixture-menu.js';
import { wireDrag, restorePos } from './panel-drag.js';
import { wireCorner } from './corner.js';
import { artForVariant, artForModel, artForWorker } from './thumb.js';
import { rciHtml, cashflowHtml } from './hud-meters.js';
import { footfallShown, setFootfallShown } from './footfall.js';
import { money } from './money.js';

/**
 * Tag and label text reaches these panels from the database, which anyone can
 * write to over MCP, so it never goes into innerHTML raw.
 */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/** Has this person ever worked a set of shutters? See `setOpen`. */
const SHUTTER_KEY = 'sns.shutterUsed';

/**
 * A mouse with one of its two buttons pressed. See `updatePrompt`.
 *
 * Drawn here rather than taken from `icons.js`, which is generated from two
 * stock icon sets: a stock mouse is one shape with both buttons the same, and
 * the entire content of this picture is that ONE of them is filled. An icon
 * that cannot say which button it means is a picture of the problem.
 *
 * The pressed half is its own path with a class on it, so the pulse is a fill
 * that lights rather than a whole glyph that flashes — a shape blinking on and
 * off reads as something wrong, and a button going down and coming back up
 * reads as a click, which is the only thing it is trying to say.
 *
 * `currentColor` throughout: the pill inverts itself when it is armed
 * (`#prompt.going`), and a glyph with a colour of its own would go on being
 * white on gold.
 */
/**
 * How long the press pill goes on eating presses after it has gone.
 *
 * See `paintPrompt`. Long enough to cover a tap already on its way to a button
 * that just left, short enough that it is never the reason a deliberate press
 * did nothing — a finger that has seen the pill go and re-aimed has taken far
 * longer than this.
 */
const PROMPT_GUARD_MS = 400;

/**
 * How long a press on a HOLD row has to last before it arms anything.
 *
 * See the pointerdown handler in `paintPrompt`. Well under `LONG_PRESS_MS` — it
 * is not a second definition of a hold, only the shortest press that is
 * obviously not a tap, and every millisecond of it is one the ring does not get.
 */
const HOLD_ARM_MS = 150;

function mouseGlyph(right) {
  // The pressed cap, drawn as the corner it actually is: down the divider,
  // along the top under the shoulder, and back. Mirrored about x=7 for the
  // right one rather than authored twice, because two hand-drawn halves drift
  // and the divider stops lining up with itself.
  const cap = right
    ? 'M7.6 1.3h1.8a3.3 3.3 0 0 1 3.3 3.3v2.1H7.6z'
    : 'M6.4 1.3H4.6a3.3 3.3 0 0 0-3.3 3.3v2.1h5.1z';
  return `<svg class="pr-mouse" viewBox="0 0 14 20" aria-hidden="true">`
    + '<rect x="1.3" y="1.3" width="11.4" height="17.4" rx="5.7"'
    + ' fill="none" stroke="currentColor" stroke-width="1.3" opacity=".55"/>'
    + '<path d="M1.3 7.4h11.4M7 1.3v6.1" stroke="currentColor"'
    + ' stroke-width="1.1" opacity=".55"/>'
    + `<path class="pr-press" d="${cap}" fill="currentColor"/></svg>`;
}

/**
 * ...and the same thing said about a key, which build mode is the first thing
 * here to need.
 *
 * Every other row on this pill is a mouse button, because every other press it
 * describes is one. R turns the selected fixture and no button anywhere does
 * that — so a row for it drawn with a mouse on the front would be promising a
 * press that does not exist, which is the green-ghost bug with a glyph on it.
 *
 * The row is still a BUTTON, and that is the half worth saying out loud: a
 * phone has no R, so on the one device that cannot make this press at all the
 * cap is hidden (see the width query in index.html) and the words are pressed
 * instead. The cap says how to do it without the pill; it is not what does it.
 *
 * Same shape the tip's own `.key` uses, because a key cap should read as a key
 * cap wherever in the game it is drawn.
 */
function keyCap(key) {
  const el = document.createElement('kbd');
  el.className = 'pr-key';
  el.textContent = key;
  return el;
}

/**
 * Split a section's rows into tabbed groups, or null if it isn't tabbed.
 *
 * A section opts in per heading, by giving its `sep` an icon: a menu with two
 * short groups is clearer as one scrolling list, and forcing tabs on everything
 * would hide four rows behind a click each. Headings without an icon stay
 * ordinary separators, which is why this returns null below two icon'd groups.
 *
 * `lead` is anything above the first tabbed heading — it belongs to the menu
 * rather than to any one tab, so it shows whichever tab is open.
 */
function tabGroups(all) {
  const groups = [];
  groups.lead = [];
  for (const r of all) {
    if (r.sep && r.icon) {
      // `passive` — a tab that reports rather than offers work. It is drawn and
      // reachable like any other; all it forfeits is being the one a menu opens
      // on. See `tabIndex`.
      // `count` is the bucket's own tally rather than `rows.length` measured
      // here, because a heading may be emitted for a bucket that ended up empty
      // — that is the whole point of drawing every tab — and the two only agree
      // while nothing filters the rows on the way in.
      // `quiet` — a bucket that is counted but does not want a badge on its
      // tab. See `grouped`: a badge reads as a count of work everywhere else in
      // the game, and the supplier's browse tabs are counting how much of the
      // catalogue exists.
      groups.push({
        label: r.sep,
        icon: r.icon,
        passive: !!r.passive,
        quiet: !!r.quiet,
        // `empty` — what the tab says with nothing in it, for a bucket whose
        // label is a verb. See the foot in `sectionHtml`.
        empty: r.empty ?? null,
        count: r.count ?? null,
        rows: [],
      });
      continue;
    }
    if (!groups.length) { groups.lead.push(r); continue; }
    groups[groups.length - 1].rows.push(r);
  }
  return groups.length >= 2 ? groups : null;
}

/**
 * The thing that actually scrolls inside a panel body.
 *
 * There are two layouts and they scroll different elements: a menu that
 * declared a middle pane scrolls THAT and leaves the body fixed, everything
 * else scrolls the body itself. Asked of the wrong one the answer is 0, which
 * is indistinguishable from "was at the top" — so this is read rather than
 * assumed, the same way `showPanel` decides `paned` from the content.
 */
function scrollerOf(body) {
  return body.querySelector('.pnl-mid') ?? body;
}

/**
 * How long a hint that is about a STATE rather than about news stays up.
 *
 * Every other line above the bar answers a question you are asking *right now*
 * — what is in my hands, what am I pointing at, what will this tap cost — so it
 * lives exactly as long as the thing it describes. "Nothing armed" is the
 * exception: it is an introduction to the mode, true from the moment build mode
 * opens until you pick something, which can be the whole time you spend
 * dragging shelves around. Read once it is furniture, and it holds the corner
 * HUD up off the bottom of the screen for as long as it sits there.
 */
const HINT_LINGER = 4000;

/**
 * How long the bar is watched for after something changes its height.
 *
 * The hint's own transition plus a frame or two of margin — see `followBar`. It
 * is a ceiling on a loop rather than a duration anything is timed to, so it only
 * has to be *at least* as long as the longest transition in `#build`.
 */
const BAR_SETTLE = 260;

/** How each kind of fixture shows up in its own menu. */
const FIXTURE_ICON = {
  shelf: ICONS.shelf, freezer: ICONS.freezer, checkout: ICONS.checkout,
  plot: ICONS.plot, station: ICONS.station,
};

/**
 * Is this held ref the same fixture as that record?
 *
 * The same two halves `isSelected` uses and for the same reason: the id goes
 * stale the moment anything re-mints the placement, and the tile alone is not
 * enough now that a decoration shares one with whatever it stands on.
 */
const refIs = (r, f) => !!r && !!f
  && (r.id === f.id || (r.x === f.x && r.z === f.z && r.kind === f.kind));

export class UI {
  constructor(net) {
    this.net = net;
    this.catalog = { items: [], crops: [], upgrades: [] };
    this.selectedCrop = null;
    /**
     * Mirrors of the two switches on the clock, so a press knows what it is
     * undoing.
     *
     * The SERVER's answer, copied down every snapshot and never decided here —
     * the same rule `selectedCrop` is written around, and for the same reason:
     * this is a shop two people share, so a local copy that thinks it is in
     * charge is a button that argues with the other player. Both messages carry
     * the state they want rather than "toggle", so the worst a stale mirror can
     * do is ask for what is already true, which the server answers with a shrug.
     */
    this.shopOpen = true;
    this.paused = false;
    // How many build presses the shop can take back, and put forward. Mirrors
    // of the snapshot, zero until the first one arrives — see `syncSteps`.
    this.undos = 0;
    this.redos = 0;
    /** Did WE stop the clock to open the Menu? See `holdForMenu`. */
    this.menuHeld = false;
    /**
     * The fixtures picked BESIDE the one the menu is about — see `togglePicked`.
     *
     * Held as refs rather than records, and cleared by `setFixtureRef` whenever
     * you pick something new without shift.
     */
    this.picked = [];
    /** Is Shift down over a selection? Then the shop shows what else is like it. */
    this.kinOn = false;
    /** ...and with the bar up, what Ctrl is about to demolish — see `setRazeAim`. */
    this.razeAim = null;
    this.buildOn = false;
    this.buildTool = 'shelf';
    /**
     * Is anything on the palette actually armed?
     *
     * Build mode used to mean "a shelf is in your hand", because `buildTool` has
     * a default and there was no way to put it down — so every tap on bare
     * ground bought something, and *looking* at your own shop with the bar up
     * was a mode you could not be in. That is what made rearranging things
     * frightening: the gesture for moving a lamp and the gesture for buying a
     * shelf were the same press a few pixels apart.
     *
     * Deliberately NOT the same question as `paletteArmed`, which stays true
     * with nothing armed: the mode is still on, so a decoration is still
     * pointable and still draggable. One flag says "pointing at the world
     * builds", the other says "the mode is up" — they were one flag, and that is
     * exactly why there was no such thing as an empty hand.
     *
     * The server is never told. It owns `build.tool` because it disarms Clear
     * after a removal, and it has no concept of *nothing* — so `syncBuildTool`
     * goes on adopting whatever kind it names, and this sits in front of the
     * answer rather than fighting it.
     */
    this.toolOff = true;
    // Which design off the catalog, when the tool is a piece. The kind is what
    // the server owns and the build rules read; this is which of that kind's
    // rows you picked, and it rides out in the place spec beside the variant.
    this.buildPiece = 'shelf';
    // Which appliance, when the tool is an appliance. Empty for every other
    // kind — see `toolId`.
    this.buildStation = '';
    this.buildVariant = '';
    // Which shape you last chose for each piece, so arming a shelf again arms
    // the shelf you were building rather than a Standard one. Keyed by piece
    // because a shape belongs to a piece — see `variantKey`.
    this.pieceVariant = {};
    // Whether the shape popover is up. It floats over the world rather than
    // sitting in the bar, so this is the whole of its state — where it goes is
    // read off the tile it belongs to, at render.
    this.shapesOn = false;
    this.buildRot = 0;
    /**
     * Which storey the palette is building on. See `FIXTURES.lift`.
     *
     * On the UI rather than on the tool, because it is a fact about where you
     * are pointing rather than about what you picked up: laying a run, a
     * loader and a junction overhead is three tools and one storey, and a deck
     * that reset with every tool would make an overhead aisle three toggles.
     */
    this.buildDeck = 0;
    // Whether that angle is YOURS. Off, the ghost faces itself against whatever
    // wall it is put against (`faceAlong`); pressing R turns the pin on and the
    // preview stops second-guessing you. See `resetRot`.
    this.rotPinned = false;
    this.buildCosts = {};
    // Which tab each bar was last left on, and which of the three has it. Kept
    // per bar rather than one shared value: they have nothing in common but the
    // strip of screen, and a roster tab is not an answer to a build question.
    this.barTab = { build: null, staff: null, upgrades: null };
    // The hire whose shoulder the camera is riding on, or null for your own.
    // See `setFollow` — a view is not part of the shop and is never sent.
    this.follow = null;
    // And which sub-tab each split tab was last left on, keyed by the tab. Same
    // reasoning one level down: Walls and Floors are two jobs, so coming back to
    // Building should put you back on the one you were doing rather than at the
    // start of the list. Only the build bar has any.
    this.barSub = {};
    this.bar = null;
    // The kind whose tile is asking a second time, and its timer — see `armHire`.
    this.hireArm = null;
    this.hireArmAt = null;
    this.el = {
      cash: document.getElementById('cash'),
      day: document.getElementById('day'),
      dow: document.getElementById('dow'),
      clock: document.getElementById('clock'),
      // The hour and the play/pause glyph are two children now rather than the
      // button's own text — `setClock` writes the time ten times a second, and
      // `textContent` on the button would take the icon out with it every tick.
      clockTime: document.getElementById('clock-t'),
      clockPP: document.getElementById('clock-pp'),
      // The date, which is also the shutters (see the CSS).
      shutter: document.getElementById('sign'),
      doorway: document.getElementById('doorway'),
      rep: document.getElementById('rep'),
      mood: document.getElementById('mood'),
      full: document.getElementById('full'),
      season: document.getElementById('season'),
      town: document.getElementById('town'),
      toast: document.getElementById('toast'),
      boardtip: document.getElementById('boardtip'),
      log: document.getElementById('log'),
      rci: document.getElementById('rci'),
      // The panel is what you grab, drag and close; the rows are what gets
      // rewritten at 10Hz. See client/corner.js for why they are two elements.
      rciRows: document.getElementById('rci-rows'),
      flow: document.getElementById('flow'),
      todo: document.getElementById('todo'),
      panel: document.getElementById('panel'),
      panelTitle: document.getElementById('panel-title'),
      panelBody: document.getElementById('panel-body'),
      carry: document.getElementById('carry'),
      stam: document.getElementById('stam'),
      build: document.getElementById('build'),
      buildGroups: document.getElementById('build-groups'),
      buildSubs: document.getElementById('build-subs'),
      buildTabs: document.getElementById('build-tabs'),
      buildTools: document.getElementById('build-tools'),
      buildStrip: document.getElementById('build-strip'),
      buildBack: document.getElementById('build-back'),
      buildOn: document.getElementById('build-on'),
      buildRaze: document.getElementById('build-raze'),
      buildShapes: document.getElementById('build-shapes'),
      buildHint: document.getElementById('build-hint'),
      buildClose: document.getElementById('build-close'),
      rotate: document.getElementById('rotbtn'),
      leave: document.getElementById('closebtn'),
      undo: document.getElementById('undobtn'),
      redo: document.getElementById('redobtn'),
      view: document.getElementById('viewbtn'),
      home: document.getElementById('homebtn'),
      pick: document.getElementById('pickbtn'),
      del: document.getElementById('delbtn'),
      marquee: document.getElementById('marquee'),
      peek: document.getElementById('peek'),
      prompt: document.getElementById('prompt'),
      rail: document.getElementById('rail'),
      search: document.getElementById('panel-search'),
      filter: document.getElementById('panel-filter'),
    };
    // Per-section, and wiped when the section closes — a filter you can't see
    // the cause of is worse than no filter at all.
    this.query = '';
    // Which aisle the open list is narrowed to, on the same terms and for the
    // same reason (`client/aisles.js`). A second narrowing, so it has to be as
    // visible and as forgettable as the first.
    this.dept = null;

    // Once, for the whole HUD. It listens on the document and adopts any
    // `title` it is pointed at, so it belongs to the shell rather than to any
    // one panel — the rail was only the first thing to want it.
    tip.install();

    // Read once. A browser that refuses the store (private mode) reads as
    // somebody who has never opened a shop, which is the safe way round: the
    // worst case is being asked again on a shop you know how to open.
    try { this.shutterUsed = localStorage.getItem(SHUTTER_KEY) === '1'; } catch { this.shutterUsed = false; }

    this.rail = new Rail(this, this.el.rail);
    // Keep the to-do chips clear of the readouts, whatever width those become.
    this.watchTopLeft();
    this.el.shutter.onclick = () => this.setOpen(!this.shopOpen);
    this.el.clock.onclick = () => this.setPaused(!this.paused);
    // Out of build mode, from the bar itself. `showBar(null)` and not
    // `toggleBuild(false)`, because those are two different exits and this one is
    // the bar's: putting the strip away disarms the tool and leaves the mode with
    // it (see `showBar`), which is exactly what the rail's own Build button does
    // — so the two ways out cannot end up meaning different things.
    this.el.buildClose.onclick = () => this.showBar(null);
    // The touch quarter-turn. Same call R makes, so the pin that stops the
    // auto-facing arguing with you comes along with it — see `rotateBuild`.
    this.el.rotate.innerHTML = ICONS.rotate;
    this.el.rotate.onclick = () => this.rotateBuild();
    // Taking a press back, for a hand that has no Ctrl+Z. The same two messages
    // the keys send and no payload either — which step comes back is a fact
    // about the shop's own stack (see `server/sim/undo.js`), so there is
    // nothing here for a button to name and nothing for it to get wrong.
    if (this.el.undo) this.el.undo.onclick = () => this.net.send('undo');
    if (this.el.redo) this.el.redo.onclick = () => this.net.send('redo');
    // Shift and Del, for a hand that has neither. The latch is the interesting
    // half — see `togglePickLatch` — and the bin is deliberately the same call
    // the key makes rather than its own message, so the two spellings of "get
    // rid of what is picked" cannot end up meaning different things.
    // Letting the latch go is "I have finished picking", which on a phone is
    // the only safe moment to put the menu up: the panel is the whole screen
    // there, so the desktop rule (the second shift-click opens it, see
    // `togglePicked`) would cover the aisle you are still picking from. Here on
    // the press rather than inside `togglePickLatch`, because that is also what
    // leaving build mode calls and a mode change must not open a menu.
    if (this.el.pick) {
      this.el.pick.onclick = () => {
        const was = this.pickLatch;
        this.togglePickLatch();
        if (was && this.manyPicked) showFixture(this, this.fixtureRef);
      };
    }
    if (this.el.del) {
      this.el.del.innerHTML = ICONS.remove;
      this.el.del.onclick = () => this.removeSelected();
    }
    // The camera, which is the one pair in this stack that sends nothing: where
    // the view is pointing is a fact about the person looking, not about the
    // shop, so it never leaves the tab. One direction only — four presses is all
    // the way round, and a second button for the other way would be a control
    // whose whole value is saving two taps of the first.
    if (this.el.view) this.el.view.onclick = () => this.scene?.rotateView(1);
    // ...and back to you. `setFollow(null)` first, because watching a hire is
    // the other way the camera can be somewhere you did not put it, and a Home
    // that left you riding a stocker would put the view back and take it away
    // again on their next step. It recentres by itself (`watch`), and the second
    // call is what handles the ordinary case of a pan with nobody followed.
    if (this.el.home) {
      this.el.home.onclick = () => { this.setFollow(null); this.scene?.recentre(); };
    }
    // ...and the way back out, on the other thumb. `toggleBuild(false)` and not
    // `showBar(null)`, which is the same distinction the bar's own close button
    // makes in the other direction: putting the strip away leaves you building
    // (see `showBar`), and this button is the one that says you have finished.
    // The rail's hammer is the desktop spelling of it.
    this.el.leave.innerHTML = ICONS.close;
    this.el.leave.onclick = () => this.toggleBuild(false);
    // One listener on the strip rather than one per chip: the list is rewritten
    // whenever it reads differently, so a handler bound to a chip would be
    // thrown away with it. The index is read back out of `_todoRuns` at press
    // time and never captured — see the comment there.
    this.el.todo.addEventListener('click', (e) => {
      const chip = e.target?.closest?.('button.todo');
      if (chip) this._todoRuns?.[Number(chip.dataset.i)]?.();
    });
    document.getElementById('search-icon').innerHTML = ICONS.search;
    this.el.town.querySelector('.ico').innerHTML = ICONS.town;
    this.el.search.oninput = () => { this.query = this.el.search.value; this.repaint(); };

    const close = document.getElementById('panel-close');
    close.innerHTML = ICONS.close;
    close.onclick = () => this.closePanel();
    /**
     * A MENU MUST NOT REBUILD ITSELF UNDER THE POINTER THAT IS USING IT.
     *
     * `panelTick` redraws a live menu only when its signature moves, which is
     * the right rule and is not the same as "rarely": a fixture menu's key
     * includes the shop's own cash and the total stock on its shelves, because
     * every row prints both — and in a trading shop those move on 11% and 34%
     * of ticks respectively. So a shelf menu left open genuinely rebuilds about
     * three times a second, from `innerHTML`, over a hundred rows of item art.
     *
     * Nothing about the words is wrong. What breaks is everything the DOM was
     * carrying: `:hover` drops and comes back, `:active` dies mid-press, and
     * the row under your cursor is a different element by the time you click
     * it. `tip.js` already documents this from the other end and pays for a
     * 260ms orphan grace to keep one card up through it.
     *
     * So the repaint waits for you to look away. Exactly the rule the pill
     * already keeps (`_overPill` in `setPressHints`) and the one `tickFixture`
     * keeps for a board being dragged, said about the panel: a control cannot
     * be rebuilt out from under the hand that is reaching for it.
     *
     * `pointerover`/`pointerleave` rather than `mouseenter`/`pointerout` — a pen
     * and a finger count, and `pointerout` fires crossing between children,
     * which on a menu of rows is every row you cross.
     *
     * The flush on the way out is the half that keeps it honest: the menu is a
     * live window, so a signature that moved while you were in there has to
     * land the moment you leave rather than waiting for the next tick that
     * happens to differ. It goes through `panelTick` like any other repaint, so
     * a menu whose key did NOT move is still not rebuilt.
     */
    this.el.panel.addEventListener('pointerover', () => { this._overPanel = true; });
    /**
     * ...and a PRESS outranks the hover, because the repaint being held off is
     * the ANSWER to that press.
     *
     * The rule above is about incidental churn — a sale, the clock, the cash —
     * arriving under a hand that is reaching for a row. A press is not that: it
     * is a finished interaction whose whole feedback is the menu coming back
     * saying something different, and your pointer is over the panel by
     * definition when you make one. So ticking a recipe wrote its line in the
     * feed and left the list drawn exactly as it was, until something unrelated
     * — moving the pointer off the panel — flushed it. What that reads as is
     * the press not having worked, in the one menu where the press IS the only
     * thing on screen that could have changed.
     *
     * A one-shot rather than a window of milliseconds: the change has to go to
     * the server and come back on a snapshot, so what is being waited for is
     * the next signature that MOVES, whenever that lands. Whoever repaints
     * clears it (`tickFixture`), which is what re-arms the hover guard for the
     * churn that follows.
     *
     * On the capture phase so a handler that stops propagation — every `data-btn`
     * and `data-act` in `wireRows` does — still arms it.
     */
    this.el.panel.addEventListener('click', () => { this._panelPressed = true; }, true);
    this.el.panel.addEventListener('pointerleave', () => {
      this._overPanel = false;
      this.panelTick?.(this);
    });
    // Grab it by its header. Filed under whichever menu is open when you let
    // go, so each one remembers its own spot — see client/panel-drag.js.
    wireDrag(this.el.panel, this.el.panel.querySelector('header'), () => this.panelPosKey());
    // The demand meter moves too, by the same machinery and into the same store.
    //
    // Two differences from the panel, both falling out of what it is. It is its
    // OWN handle rather than having a header to grab — there is nothing else on
    // it, and a bar chart with a title bar would be mostly title bar. And its id
    // is a constant instead of `openPanel`: one element showing one thing
    // remembers one place, where the panel is six menus sharing a frame.
    //
    // Filed under a name no section uses, since both share `sns-panel-pos`.
    wireDrag(this.el.rci, this.el.rci, () => 'rci');
    restorePos(this.el.rci, 'rci');
    // ...and it can be put away entirely, which moving it never covered: every
    // place you can drag it to is over something. The Menu brings it back.
    wireCorner(this.el.rci, 'rci', (msg) => this.toast(msg));
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.escape();
    });
    // On the window rather than on the feed — see `hoverLog`. The canvas gets
    // the event and it bubbles here, so the log can stay untouchable and still
    // know when you are looking at it.
    addEventListener('pointermove', (e) => this.hoverLog(e.clientX, e.clientY));
    // A card floating over the world goes when you touch anything that is not
    // it. Capture, so it closes before whatever you pressed acts — pressing the
    // ground with it up should build there and leave nothing behind. The tile's
    // own press is included on purpose: closing and reopening is what makes a
    // second hold on the same tile a toggle rather than a no-op.
    addEventListener('pointerdown', (e) => {
      if (!this.shapesOn || e.target.closest?.('#build-shapes')) return;
      this.shapesOn = false;
      // Hidden directly rather than through `renderHotbar`, and that is not an
      // optimisation. A repaint replaces every tile in the strip, and a button
      // removed from the document between pointerdown and pointerup never fires
      // its click — so with the card up, the press that was going to arm the
      // freezer would land on a button that stopped existing halfway through it,
      // and the tile would simply not respond. Nothing else about the bar
      // changes when this closes, so nothing else needs redrawing.
      if (this.el.buildShapes) this.el.buildShapes.hidden = true;
    }, true);
    this.renderHotbar();
  }

  setCatalog(catalog) {
    this.catalog = catalog;
    this.buildCosts = catalog.buildCosts ?? this.buildCosts;
    // A seed is NOT chosen here, and that line cost real money for as long as
    // it existed. It picked `crops[0]` — Carrot Row, by catalogue order rather
    // than by anything the player did — and *sent* it, so the shop's standing
    // answer to "what goes back in the bed" was set by a page load. Plant
    // tomatoes, refresh (or lose wifi for four seconds, or get a hot reload),
    // harvest: the bed comes back carrots and you are charged for the seed.
    // Nothing on screen ever said a seed was selected at all, so it read as
    // the game replanting at random.
    //
    // The selection is the server's now and only ever mirrored down — see
    // `update`. Nothing chosen falls back to replanting what you just picked,
    // which is what a player who has never touched a seed picker expects.
    this.renderHotbar();
    // If a section is open, redraw it so newly-added content appears instantly.
    // A fixture menu isn't a section and refreshes itself from the snapshot.
    if (this.openPanel && this.openPanel !== 'fixture') this.showSection(this.openPanel);
  }

  // ---- build mode ----------------------------------------------------------

  /**
   * Pressing Build — the rail's hammer, or G. Three states, in the order you
   * arrive at them.
   *
   * The mode and the palette used to be one press, so the only way to be in
   * build mode was with a strip of shelves across the bottom of the screen —
   * and most of what the mode is for is *rearranging what is already there*:
   * dragging a unit two tiles over, turning it, opening a doorway. None of that
   * needs the catalogue, and the catalogue is the biggest thing on screen.
   *
   * So: first press is the mode (drag things about, aim at walls, fly the view),
   * second press is the palette, third puts both away. The toast on the first
   * one is the exception to "the mode, and nothing else" below — a second press
   * that does something different from the first is not a thing anybody finds by
   * pressing once, so it is said once, where it happens.
   */
  pressBuild() {
    if (!this.buildOn) { this.toggleBuild(true); return; }
    // Asking for the palette is asking for the mode, which matters when the one
    // you are standing in was borrowed by a fixture menu: without this the
    // shelves would be up over a mode `paletteArmed` still called somebody
    // else's, so nothing you pointed at would build.
    if (this.bar !== 'build') {
      // You did the thing it asked; the note has nothing left to say.
      this.rail.clearNote();
      this.commitBuildMode();
      this.showBar('build');
      return;
    }
    this.toggleBuild(false);
  }

  toggleBuild(on = !this.buildOn, { quiet = false } = {}) {
    this.buildOn = on;
    // The mode opens with empty hands. Turning building on is "let me at my
    // shop", not "sell me a shelf" — and the first thing anybody does in here is
    // look at what is already built, which used to mean crossing the floor with
    // a loaded pointer. Arming is one press away and is now a thing you *say*.
    //
    // On the way out too, or the mode remembers a tool across a session and the
    // first tap of the next one buys whatever you last built.
    this.toolOff = true;
    // Building flies the view where nobody can stand (`setFreeRoam`), and
    // riding on a hire moves what it is flying *from* — two things steering one
    // camera. Building wins: you asked for the wheel.
    if (on) this.setFollow(null);
    this.resetRot();
    // ...and back to the floor. The one place `buildDeck` is reset, and the
    // argument is `resetRot`'s pointed at a storey: a deck held across a
    // session means the first press of the next one lands on a ceiling nobody
    // asked for, over ground you were looking at.
    this.buildDeck = 0;
    // The mode no longer brings the palette with it — that is the second press
    // (`pressBuild`), because the bar is the most expensive thing on screen and
    // most of building is rearranging what you already own. What entering the
    // mode DOES do is clear the bar somebody else was using, for the same reason
    // `showBar` leaves the mode when it hands the strip to the roster: two
    // things cannot have the bottom of the screen.
    //
    // Going out takes the palette with it, and hands the bar back to nobody —
    // the roster does not come back just because you stopped building, since you
    // never asked for it.
    //
    // Except when a menu borrowed the mode for one action of its own, which is
    // what `quiet` means. Every verb in a fixture's menu is gated on build mode
    // server-side, so pressing Rotate has to switch it on — but you asked to
    // turn a shelf, not to go shopping for shelves, and throwing the build
    // palette up over the menu you are still reading answers a question nobody
    // asked. The mode goes on, the bar stays where you left it.
    if (!quiet) {
      // A mode you pressed for yourself is yours, whatever a menu was doing with
      // it a moment ago. Without this the flag outlives the mode it described:
      // borrow the mode from a fixture menu, press G twice, and `paletteArmed`
      // would still call the mode you just chose somebody else's.
      this._modeFromMenu = false;
      this._modeQuiet = false;
      if (this.bar === 'build' || (on && this.bar)) this.bar = null;
    }
    this.rail.setBar(this.bar);
    // A latch that outlived its mode is a shop where tapping a shelf next time
    // mysteriously does not open it, with the button that explains why off
    // screen. Let go of on the way in as well as out: the mode a fixture menu
    // borrows and hands back is a state you can leave this holding.
    this.togglePickLatch(false);
    this.markBuilding();
    // A way's menu goes with the fixture's: both are rows of build verbs, and a
    // doorway can only be *pointed at* in the mode (see `pickWay`), so one left
    // up out of it is a menu on something you can no longer aim at.
    if (!on && (this.openPanel === 'fixture' || this.openPanel === 'way')) this.closePanel();
    // The working-spot rings belong to the mode (see `markerSpots`), and the
    // mode can change with something already selected — so the marker has to be
    // re-asked here. Keyed on the spots it was built with, so this is a no-op
    // whenever the answer has not moved, and there is nothing selected most of
    // the time anyway.
    if (this.fixtureRef) this.scene?.setSelectedTarget(this.fixtureRef, this.markerSpots(this.fixtureRef));
    // Only a fixture kind means anything to the server (see `selectBuildTool`).
    // Leaving it out keeps whatever it already had, which is the right answer
    // for a mode toggle made with a wall in your hand.
    this.net.send('build-mode', {
      on, tool: this.armedEdgeTool() ? undefined : this.buildTool,
    });
    this.renderHotbar();
    // `quiet` is for a mode a button switched on around one action of its own:
    // the fixture visibly turning is the feedback, and announcing a mode change
    // either side of it says twice as much as happened.
    if (quiet) return;
    // The mode, and nothing else. It used to carry three instructions — what a
    // tap on the ground does, what a tap on a fixture does, what WASD does now —
    // which is the welcome-toast mistake said again: a list nobody reads at the
    // one moment they cannot use it. All three are answered where they happen,
    // by the ghost under the pointer and the line above the bar — and so is the
    // second press, by the lit button that is now two states rather than one.
    this.toast(on ? 'Build mode enabled' : 'Back to shopkeeping');
    // ...and the half of it that is about the button rather than about the shop
    // goes over the button (`Rail.note`). The palette used to come up with the
    // mode, so a mode that appears to have opened onto nothing has to say where
    // the shelves went — and it has to say it where they would have been.
    // ...and it names the TAP as well as the drag, because a drag on its own
    // stopped being the whole gesture: a fixture is moved by pulling the one you
    // have selected, and a press on anything else turns the view. "Drag things
    // about" was the instruction for the version where any press moved anything,
    // and left on it, it is a note over a button promising a press the shop
    // answers by panning — which reads as the mode not having come on.
    if (on) this.rail.note('Tap a thing, then drag it — click again for the menu');
    else this.rail.clearNote();
  }

  /**
   * The frame round the window (`#edge`), which says one of three things about
   * the world: you are building, the shop is shut, or the clock is stopped.
   *
   * `paletteArmed` and not `buildOn`, which is the same distinction every other
   * reader of the mode draws: a fixture menu borrowing it for one press of
   * Rotate must not light up the whole screen, and it is the only mode that puts
   * nothing else on screen either.
   *
   * The other two are set in `setClock`, where the numbers they come from
   * already are. Which one wins is CSS's (see `#edge`), not a decision made
   * here — three booleans and one frame, and a precedence written as `if`s here
   * would be a second opinion about it.
   *
   * Called from `update` as well as from the toggle, because `commitBuildMode`
   * and `releaseMenuMode` both change the answer without going through one.
   */
  markBuilding() {
    document.body.classList.toggle('building', this.paletteArmed);
  }

  /**
   * Do something the server only lets you do in build mode, from a menu you can
   * be standing in without it.
   *
   * A fixture menu opens on a tap, in or out of the mode — looking at a thing
   * never needed permission. But the server takes build mode as the consent for
   * every verb that names a fixture by id, so a menu opened without it had a
   * row of buttons that all answered "not in build mode". Pressing one *is* the
   * consent — you tapped that fixture and then chose the verb — so the button
   * brings the mode with it rather than refusing. It's still the menu's mode,
   * so it leaves when the menu does; `commitBuildMode` is how a verb keeps it.
   */
  withBuildMode(run) {
    if (!this.buildOn) {
      this._modeFromMenu = true;
      this._modeQuiet = true;
      this.toggleBuild(true, { quiet: true });
    }
    run();
  }

  // ---- moving one thing ----------------------------------------------------
  //
  // Moving something is an errand, not a change of career. You opened a
  // fixture's menu, pressed Move, and put it down — so the place to be
  // afterwards is back in that menu looking at the thing you just moved.
  //
  // What happened instead was that the drop *committed* build mode: the palette
  // re-armed, and the next tap on the floor bought a brand new shelf. "Put this
  // here" is not a decision to start buying shelves.

  /**
   * Pressing Move. `borrowed` is the same distinction `_modeFromMenu` draws
   * everywhere else — a mode a menu switched on for you goes back off at the
   * end of the errand; a mode you chose yourself with G is yours and stays.
   */
  startMove(f, opts = {}) {
    // `reopen` says whether finishing puts the menu back on it. True from the
    // menu's Move button, because that is where you were; false when you pulled
    // the thing out by pointing at it, because you were not anywhere.
    this._move = {
      kind: f.kind, borrowed: !!this._modeFromMenu, to: null, reopen: opts.reopen !== false,
    };
    // `holding` isn't true until the next snapshot lands, and the menu is about
    // to close in front of it. Without a marker for that gap `releaseMenuMode`
    // hands the mode back mid-lift, and the server drops what you picked up.
    this._lifting = true;
  }

  /** Where the drop is aimed, so the errand can find the fixture afterwards. */
  markMoveTarget(tile) {
    this._move = { ...(this._move ?? { borrowed: false }), to: { x: tile.x, z: tile.z } };
  }

  /**
   * Back to the shop list.
   *
   * A reload rather than a teardown, deliberately. Leaving cleanly means
   * dropping the room, disposing every mesh in two scene roots, clearing the
   * prop maps, and resetting a dozen fields on this object — and the prop maps
   * have already leaked a full set of stock meshes once for exactly that kind
   * of miss (see `buildWorld`). The world state is on the server, the reload
   * costs a second, and there is no half-torn-down shop to get wrong.
   *
   * Dropping `?world` is what makes the menu show rather than rejoining.
   */
  leaveToMenu() {
    // Hand the clock back BEFORE the reload, because this is the one way out of
    // the Menu that never closes it: `location.replace` takes the page with the
    // panel still up, so nothing would ever run the release. A pause is a
    // persisted stamp (see `setPaused` on the server), so the shop you walked
    // out of would still be stopped when you walked back in — with the press
    // that stopped it three screens ago and nothing to connect the two.
    this.holdForMenu(false);
    const url = new URL(location.href);
    url.searchParams.delete('world');
    location.replace(url);
  }

  /** A refusal came back while our hands were still empty: no lift happened. */
  abortMove() {
    if (!this._lifting) return;
    this._lifting = false;
    this._move = null;
    this.releaseMenuMode();
  }

  /**
   * Hands empty again — set down, put back, or taken off us. Give the mode back
   * if it was only on loan, then put the menu on whatever we were carrying.
   */
  endMove() {
    const move = this._move;
    this._move = null;
    this._lifting = false;
    if (!move) return;
    // Mode first: `toggleBuild(false)` shuts an open fixture menu, so handing it
    // back second would close the menu we just reopened.
    if (move.borrowed) {
      this._modeFromMenu = true;
      this.releaseMenuMode();
    }
    // By tile, not by id — being set down re-mints it as a fresh placement, for
    // the same reason `refreshFixture` looks things up this way.
    const f = move.to ? this.scene?.fixtureAt(move.to.x, move.to.z) : null;
    if (!f) return;
    // Put it back down and it is still the thing you are working on. The lift
    // re-mints the placement, so the selection cannot simply survive — the id it
    // was holding stops existing the moment the fixture does — and what that
    // reads as is the shop letting go of the thing the instant you finish
    // moving it: R turns nothing, the pill goes back to "Select it", and lining
    // a lamp up is a re-select between every nudge.
    //
    // SEPARATE FROM `reopen`, which is about the menu and stays a fact about
    // where you came from: pulling something out by pointing must not leave a
    // panel open on every lamp in a row, and that argument says nothing about
    // which thing is selected. Selecting is what pointing at it did in the first
    // place.
    this.selectFixture(f);
    if (move.reopen) showFixture(this, f);
  }

  selectBuildTool(id) {
    const t = buildTools(this).find((x) => x.id === id);
    if (!t) return;
    // Picking one is the thing that fills an empty hand, and it is every route
    // in: the bar, the number keys, and the server disarming Clear onto
    // something else. Anything that can arm a tool comes through here.
    this.toolOff = false;
    // The entry knows what it is. It used to be parsed back out of the id, which
    // worked while the only compound id was `station:blender` and stopped the
    // moment a piece id was free-form — a planter called `plot-marker` would
    // have been read as a plot.
    // Arming a tool is what puts a copied stamp down. Both are "the thing that
    // goes down when you press", and two of them under one pointer would be two
    // promises about one press — so this is the pair to `copySelection`'s own
    // `disarmTool`, said from the other end.
    this.dropStamp?.();
    /**
     * ...and it drops the SELECTION, which is the third thing that was making a
     * promise about the same press.
     *
     * A ring says "this is the thing you are working on" — R turns it, M picks
     * it up, Delete takes it out. A tool says "this is the thing that goes down
     * where you press". Both at once is the state you land in every time you
     * move something: `endMove` re-selects what you just set down on purpose (or
     * lining a lamp up is a re-select between every nudge), so reaching for the
     * bar to build the *next* one leaves the last one ringed, and the shop is
     * then holding two answers to what your hands are for. What it reads as is
     * the selection being stuck, because nothing you do with the new tool ever
     * clears it.
     *
     * `selectFixture(null)` rather than `setFixtureRef(null)`, for the ordering
     * that method exists to state: a menu open over the thing is a menu about a
     * ring that is going, and a panel outliving its ring is the disagreement the
     * setter's own note refuses.
     */
    this.selectFixture(null);
    this.buildTool = t.kind ?? t.id;
    this.buildPiece = t.piece ?? '';
    this.buildStation = t.station ?? '';
    this.resetRot();
    // Follow the entry to its tab when it isn't on the one you're looking at.
    // Selections arrive from off-bar too — the server disarms Clear by kind —
    // and a lit button on a hidden tab is an armed tool nothing on screen names.
    // An entry that lives on two tabs stays on whichever one you found it on.
    //
    // Against what is *drawn*, which since Building split is one sub-tab rather
    // than the whole group: a wall armed while you are looking at Floors is as
    // hidden as one armed while you are looking at Farm.
    const here = this.openBuildGroup();
    if (!here.items.some((x) => x.id === t.id)) {
      const g = groupOfTool(t);
      if (g) {
        this.barTab.build = g;
        const s = subOfTool(t, g);
        if (s) this.barSub[g] = s;
      }
    }
    // Shapes belong to a piece, so switching piece cannot carry the old one over
    // — nobody drew a "corner till". What it CAN do is remember: you pick the
    // wall-run shelf once and every shelf you arm after that is a wall-run
    // shelf, until you say otherwise. Re-deriving Standard each time made the
    // choice a thing you re-made on every trip to the bar, which for a row of
    // shelving is the same decision typed out nine times.
    this.buildVariant = this.pieceVariant[this.variantKey()] ?? '';
    // Whatever the popover was open over, it is not this.
    this.shapesOn = false;
    this._toolId = t.id;
    // An edge tool is not a fixture and the server keeps no state for one:
    // `setBuildTool` refuses anything outside FIXTURES, so telling it "fence"
    // only ever produced "no such build tool" on screen. Drawing one names its
    // own kind in `build-edge`, so there is nothing to tell it. Wall, window and
    // doorway have always done this — the Farm tab just put two more of them
    // one press away, which is how a silent refusal became a visible one.
    this._sentTool = null;
    // A brush is in the same position as a wall here and for the same reason:
    // `setBuildTool` refuses anything outside FIXTURES, and ground is
    // deliberately not in FIXTURES because it is what a cell is made of rather
    // than a thing standing on it. Painting names its own piece in
    // `build-ground`, so there is nothing to tell the server.
    //
    // ...and a FINISH is the third of them, which is the whole list of things
    // this guard has to know about: every kind that is not in `FIXTURES`. It
    // shipped one press behind, exactly as the Farm tab's two edge tools did —
    // the tool worked perfectly (it names its own piece in `paint-face`) and
    // said "no such build tool" while doing it, which is the same silent
    // refusal becoming a visible one. Written as "is it a fixture" rather than
    // as a list of exceptions, so the next kind outside that table cannot
    // arrive with this line still passing.
    if (t.edge === undefined && !t.paint && !t.face) {
      this._sentTool = this.buildTool;
      this.net.send('build-tool', { tool: this.buildTool });
    }
    this.renderHotbar();
  }

  /**
   * What a remembered shape is filed under.
   *
   * The PIECE, not the palette entry and not the kind. A shape is a row on a
   * piece (`variantsOf`), so two designs of shelf have two different sets of
   * them and remembering "corner" against the kind would hand a corner to a
   * piece that has no such row. Falling back to the kind covers a tool that
   * names no piece, which is every tool that has no shapes anyway.
   */
  variantKey() {
    return this.buildPiece || this.buildTool || '';
  }

  /**
   * Open or shut the shape popover.
   *
   * It is a *floating* card anchored over its tile rather than a row in the bar,
   * which is the whole reason it exists in this form: as a tier it changed the
   * height of the bar and moved every tab on it, and it did that on the way in
   * and again on the way out, while you were aiming at something. A row that
   * shoves the thing you are pointing at is worse than one press.
   */
  toggleShapes(on = !this.shapesOn) {
    this.shapesOn = !!on;
    this.renderHotbar();
  }

  /**
   * Which shape of the selected fixture the next tap builds.
   *
   * Client-side only, and deliberately: it rides along in the `build-place`
   * spec rather than becoming another piece of build state the server has to
   * own and re-sync. The tool is server-owned because removing something
   * disarms it; nothing on the server ever changes your mind about a shape.
   */
  selectBuildVariant(id) {
    this.buildVariant = id ?? '';
    this.pieceVariant[this.variantKey()] = this.buildVariant;
    // Picking one is the end of the question, so the popover goes with it.
    this.shapesOn = false;
    // `renderHotbar`, not a repaint of the shape row alone — there is no such
    // method and there never was, so every press of a shape button threw before
    // it reached the hint below it. It read as a row that ignores you: the
    // variant *was* set and the next shelf you placed was a corner unit, but
    // nothing on screen moved, so the way to get a corner shelf was to press
    // Corner and then not believe the bar.
    this.renderHotbar();
  }

  /**
   * The palette entry currently selected.
   *
   * Remembered rather than rebuilt from its parts, because a piece id is
   * free-form and so cannot be reconstructed from a kind and a suffix. Falls
   * back to the first entry of whatever kind the server says we are holding,
   * which is what `syncBuildTool` needs when the server disarms us.
   */
  toolId() {
    // Nothing armed is a real answer, and one place to give it. Everything that
    // asks what a tap would do goes through here — the ghost's kind, the wall
    // tool, the brush, the bulldozer, the lit button on the bar — so an empty
    // hand costs those callers nothing and cannot be forgotten by one of them.
    if (this.toolOff) return null;
    if (this._toolId) return this._toolId;
    if (this.buildStation) return `station:${this.buildStation}`;
    return this.buildPiece || this.buildTool;
  }

  /**
   * The three questions the pipette asks of the palette.
   *
   * All of them are `buildTools(this)` lookups and none of them is new state,
   * which is the whole reason Q is cheap: the bar is already a list of every
   * design in the game, keyed by exactly the ids a placement carries. They live
   * here rather than in `main.js` because `buildTools` is the palette's own
   * catalogue and a second reader of it in another file is two answers to "what
   * can be armed" — the disagreement being a key that arms something the bar
   * cannot show you it armed.
   *
   * `buildToolByEdge` is the one that is not an id lookup: a wall is not a
   * piece, so the only thing an edge tool and a standing wall have in common is
   * the kind number. Which is exact — the four signed doorways and the four
   * glazings are separate entries — so pointing at a staff door arms a staff
   * door rather than a doorway.
   */
  hasBuildTool(id) { return !!buildTools(this).find((x) => x.id === id); }

  buildToolName(id) {
    return (buildTools(this).find((x) => x.id === id)?.name ?? 'it').toLowerCase();
  }

  buildToolByEdge(kind) {
    return buildTools(this).find((x) => x.edge === kind)?.id ?? null;
  }

  /** Is a palette entry armed — that is, would a tap on bare ground build? */
  get toolArmed() {
    return this.paletteArmed && !this.toolOff;
  }

  /**
   * Put it down. The bar stays up and the mode stays on.
   *
   * `resetRot` with it: an angle is part of a placement decision, and the next
   * thing armed has not made one. See `resetRot`.
   */
  disarmTool() {
    if (this.toolOff) return;
    this.toolOff = true;
    this.shapesOn = false;
    this.resetRot();
    this.renderHotbar();
    this.renderBuildHint();
  }

  /**
   * The server owns the build tool, because it disarms Clear after a removal.
   * Adopt its value — but only once it has caught up with the last tool we
   * sent, or an in-flight snapshot would undo the button you just pressed.
   */
  syncBuildTool(serverTool) {
    if (!this.buildOn || !serverTool) return;
    // Except while an edge tool is armed. The server was never told about that
    // one and is still holding the last fixture you picked, so adopting its
    // answer would take the wall back out of your hand a tick after you chose it.
    if (this.armedEdgeTool()) return;
    if (this._sentTool && serverTool !== this._sentTool) return;
    this._sentTool = null;
    if (serverTool === this.buildTool) return;
    this.buildTool = serverTool;
    // The server said a kind, so whichever appliance or design we had chosen is
    // no longer what's selected. Leaving either set would build a blender out of
    // the Shelf button the next time the server disarmed us. Adopting the first
    // palette entry of that kind is what turns a kind back into a whole choice.
    if (serverTool !== 'station') this.buildStation = '';
    const t = buildTools(this).find((x) => x.kind === serverTool);
    this.buildPiece = t?.piece ?? '';
    this._toolId = t?.id ?? null;
    this.resetRot();
    this.renderHotbar();
  }

  /**
   * Whether what's armed draws on an edge rather than placing a fixture.
   *
   * Read off the palette entry rather than through `edgeKindForTool`, which
   * answers null while you're carrying something — that question is about what
   * ghost to draw, and this one is about what the server has been told.
   */
  armedEdgeTool() {
    const t = this.armedTool();
    // Everything that is not a fixture, which is what the one caller means by
    // it: `toggleBuild` sends the armed tool along with the mode, and the
    // server refuses anything outside `FIXTURES` by name. A finish is the third
    // such tool — see the note in `selectBuildTool`.
    return t?.edge !== undefined || !!t?.paint || !!t?.face;
  }

  /**
   * The ground this tool paints, or undefined if it doesn't paint.
   *
   * Three states, not two, which is why this returns a pair rather than a
   * boolean: a design lays that ground, an empty piece takes it up, and
   * undefined means this tool is not a brush at all. Collapsing the first two
   * would make "Bare Ground" indistinguishable from "no tool".
   *
   * The KIND comes back alongside the piece because a brush lays three
   * different things now — floor, delivery bay, storage — and the ghost has to
   * ask `canPaintGround` which one it is holding. The server does not trust
   * this: it reads the kind off the catalog row the piece names.
   */
  /**
   * Is the mode YOURS — that is, does pointing at the world build rather than
   * shop?
   *
   * Build mode is two things wearing one flag: the **permission** the server
   * gates its fixture verbs on, and the **mode** that turns pointing at the shop
   * into building it. A menu that borrows the mode for one press of Empty or
   * Rotate needs the first and never asked for the second — pressing Empty must
   * not silently make the ornaments clickable, the walls openable or WASD fly.
   *
   * The bar used to be the test for that, and it was the right test right up
   * until the palette became a second press (`pressBuild`): build mode with the
   * bar down is a state you can now deliberately be in — the one where you
   * rearrange what is already built without a strip of shelves over your shop —
   * and the bar test called that mode borrowed. So the honest question is who
   * asked for the mode, which `_modeFromMenu` is exactly the answer to.
   *
   * What the bar was ALSO protecting is a separate rung and stays where it is:
   * a tap on bare ground only buys something while a tool is armed
   * (`toolArmed`), and a mode nobody chose off the palette opens with `toolOff`.
   * That is what stops a borrowed mode buying a shelf, and it is why putting the
   * bar away disarms (see `showBar`) — an armed tool with no bar on screen is
   * the same invisible purchase wearing the other hat.
   *
   * Deliberately not `armedEdgeTool`'s test: that one asks what the *server*
   * has been told, which is a different question and must keep its answer.
   */
  get paletteArmed() {
    return this.buildOn && !this._modeFromMenu;
  }

  /**
   * Tell the server what mode this client thinks it is in.
   *
   * For a rejoin, and nothing else. Build mode lives on the PLAYER record, which
   * is keyed by session, so a new socket is a player who has never heard of it —
   * and the client's own `buildOn` survives the drop, because nothing about a
   * socket closing changes what is on screen. The two disagreeing is silent: the
   * bar is up, the ghost is green, and every verb comes back refused.
   *
   * Deliberately not `toggleBuild(this.buildOn)`, which is a mode CHANGE — it
   * disarms the tool, drops the follow and resets the rotation. Nothing changed
   * here; the far end just forgot.
   */
  resendMode() {
    this.net.send('build-mode', {
      on: this.buildOn,
      tool: this.armedEdgeTool() ? undefined : this.buildTool,
    });
  }

  groundForTool() {
    if (!this.paletteArmed || this.holding) return undefined;
    const t = buildTools(this).find((x) => x.id === this.toolId());
    if (!t?.paint) return undefined;
    return { kind: t.piece ? t.kind : null, piece: t.piece ?? '' };
  }

  /**
   * The finish this tool paints, or undefined when it is not a paint tool.
   *
   * `groundForTool`'s sibling, and separate for the reason the flags are: they
   * are two different gestures over two different things, and every reader
   * below branches on which. An empty piece is the brush's null entry — Bare
   * Wall — exactly as it is for ground.
   */
  faceForTool() {
    if (!this.paletteArmed || this.holding) return undefined;
    const t = buildTools(this).find((x) => x.id === this.toolId());
    if (!t?.face) return undefined;
    return { piece: t.piece ?? '' };
  }

  /** The palette entry currently armed, or null outside build mode. */
  armedTool() {
    if (!this.buildOn) return null;
    return buildTools(this).find((x) => x.id === this.toolId()) ?? null;
  }

  /**
   * Whether the bulldozer is up.
   *
   * What it changes is what a *tap on a thing* means: normally looking, here
   * tearing out. Everything that would otherwise open a menu has to ask.
   */
  demolishArmed() {
    // Same reason the ghost asks: a mode a menu borrowed for one press must not
    // leave the bulldozer up, or pressing Empty and then tapping the next unit
    // along tears it out.
    return this.paletteArmed && !!this.armedTool()?.demolish && !this.holding;
  }

  /**
   * Tear out what you aimed at.
   *
   * The same message the fixture's own menu sends, because it is the same verb —
   * the server refuses a fixture with contents in it or your last till either
   * way, and refunds the same half. What the bulldozer changes is only how you
   * name the target: by pointing at it rather than by opening its menu first.
   */
  razeFixture(f) {
    if (!f) return;
    this.commitBuildMode();
    this.net.send('build-remove', { id: f.id });
  }

  /** The fixture the ghost should be showing, or null when there isn't one. */
  /** The edge kind this tool draws, or null if it places a fixture instead. */
  edgeKindForTool() {
    if (!this.paletteArmed || this.holding) return null;
    const t = buildTools(this).find((x) => x.id === this.toolId());
    return t && t.edge !== undefined ? t.edge : null;
  }

  ghostKindForTool() {
    if (!this.buildOn) return null;
    // A wall tool aims at a line, not a square, so there is no tile ghost.
    if (this.edgeKindForTool() !== null) return null;
    // A brush aims at a square but paints what it is made of rather than
    // standing something on it, so the fixture ghost would be a shelf-shaped
    // box hovering over ground you were about to tile.
    if (this.groundForTool() !== undefined) return null;
    // ...and a finish aims at neither: it goes on the side of a wall, so it has
    // no tile at all — the same reason a wall tool has no tile ghost, said one
    // dimension further in.
    if (this.faceForTool() !== undefined) return null;
    // What's in your hands outranks what's on the palette: while you're
    // carrying a shelf, every tile you point at is a candidate home for *it*.
    // And carrying is the one thing that arms a tap without the palette being
    // up at all — a Move errand borrows the mode the same way Empty does, so
    // the hands are asked before `paletteArmed` refuses.
    if (this.holding) return this.holding.kind;
    // `toolArmed`, not `paletteArmed`. This is the one reader that goes to
    // `buildTool` directly rather than through `toolId`, because a ghost needs
    // the KIND and the id is a piece — so it is also the one place an empty hand
    // has to be spelled out, and the one that would otherwise put a shelf-shaped
    // ghost under a pointer with nothing armed.
    return this.toolArmed ? this.buildTool : null;
  }

  /**
   * Which catalog row the ghost should be DRAWN as — the design, the shape and
   * the rung, none of which changes where the thing may go.
   *
   * Separate from `ghostKindForTool` on purpose, and the split is the same one
   * `shared/pieces.js` makes: the kind is what `canPlace` judges, the piece is
   * what gets drawn. The ghost only ever knew the first half, so every design of
   * a kind previewed as the same grey box — you could tell a Bakery Case from a
   * Produce Table on the palette button and not at the moment you placed it.
   *
   * A tier of 1 for something new, because that is what you get for your money;
   * a carried fixture keeps the rung it has already been upgraded to, or moving
   * a maxed-out freezer would preview as the base model.
   */
  ghostPiece() {
    if (this.holding) {
      return {
        piece: this.holding.piece ?? null,
        variant: this.holding.variant ?? '',
        station: this.holding.station ?? null,
        tier: this.holding.tier ?? 1,
      };
    }
    return {
      piece: this.buildPiece || null,
      variant: this.buildVariant ?? '',
      station: this.buildStation ?? null,
      tier: 1,
    };
  }

  /**
   * R, with a fixture's own menu open, turns THAT fixture.
   *
   * The same message the menu's Rotate button sends, on the key that has always
   * meant "turn it" everywhere else — so the one place you are unambiguously
   * talking about a single fixture was the one place the key did not apply, and
   * turning a lamp meant crossing to a button in a popover.
   *
   * By id first and by tile second, because a rotation re-mints the placement:
   * the id is right until the snapshot lands and the tile is right afterwards,
   * and for a decoration the tile is only *nearly* right — it shares one.
   *
   * `withBuildMode`, exactly as the button does: every fixture verb is gated on
   * the mode server-side, and pressing R is not a decision to go shopping.
   * Answers whether it took the key, so the caller can fall through to turning
   * the ghost when nothing is selected.
   */
  rotateSelected(dir = 1) {
    const f = this.selectedFixture();
    if (!f) return false;
    // With several picked, R is the Rotate button and says what it says: one at
    // a time. Turning only the first of six would be the one key in the game
    // that quietly acts on part of a selection, and which part is invisible —
    // the ring is on all of them. It still takes the key rather than falling
    // through to turning the ghost, or R would start placing shelves.
    if (this.manyPicked) { this.toast(ONE_AT_A_TIME); return true; }
    this.withBuildMode(() => this.net.send('build-rotate', { id: f.id, dir }));
    return true;
  }

  /**
   * Tear the selection out — Delete, which is the Remove button's key.
   *
   * The one selection verb that is NOT one at a time, for the reason its own
   * square gives: a shift-click over six shelves is a press people make in
   * order to clear an aisle. So unlike `rotateSelected` this sends the whole
   * list, and the server folds it into one undo step, one re-flow and one line.
   *
   * `withBuildMode` like every other fixture verb, and it closes the panel
   * because what that panel is about is on its way out. Answers whether it took
   * the key: with nothing selected Delete belongs to whatever comes next rather
   * than tearing out whatever the pointer happens to be over, which is the
   * proximity bug the bulldozer already answers properly.
   */
  removeSelected() {
    const f = this.selectedFixture();
    if (!f) return false;
    // Read before anything else runs: `closePanel` below drops the selection
    // (`setFixtureRef(null)`), and so would anything that decided to close the
    // menu on the way into build mode.
    const ids = this.pickedIds();
    this.withBuildMode(() => this.net.send('build-remove', { id: f.id, ids }));
    this.closePanel();
    return true;
  }

  /**
   * The fixture that is SELECTED, live off the layout.
   *
   * Deliberately no longer "the one this menu is open on". Selection and the
   * menu used to be one fact, because the only way to point at something was to
   * open it — a tap on a shelf was a tap on its settings, which is a lot of
   * panel for a question you often did not have. They are two facts now: the
   * first tap picks the thing (teal ring, working spots, and R and M have
   * something to act on), and the second asks it to open. So the menu implies a
   * selection and a selection no longer implies the menu.
   *
   * By id first and by tile second, because a rotation re-mints the placement:
   * the id is right until the snapshot lands and the tile is right afterwards,
   * and for a decoration the tile is only *nearly* right — it shares one.
   *
   * Null with your hands full: every verb it feeds acts on something standing in
   * the shop, and what you are carrying is not standing anywhere.
   */
  selectedFixture() {
    if (!this.fixtureRef || this.holding) return null;
    return this.scene?.fixtureById(this.fixtureRef.id)
      ?? this.scene?.fixtureAt(this.fixtureRef.x, this.fixtureRef.z)
      ?? null;
  }

  /**
   * Pick a thing without opening it — the first press of the two.
   *
   * Closes a fixture menu already up on something ELSE first, and the order is
   * the whole of why this is a method rather than two lines at each call site:
   * `closePanel` clears the ref, so setting the new one first would leave the
   * ring pointing at nothing while the panel it belonged to was being torn down.
   */
  selectFixture(f) {
    if (this.openPanel === 'fixture') this.closePanel();
    this.setFixtureRef(f);
  }

  /**
   * Is this the thing already picked?
   *
   * Id OR tile-and-kind, and it needs both halves. The id goes stale the moment
   * anything re-mints the placement (rotating, a re-flow), which is the reason
   * every other comparison in here is by tile — and the tile alone is not enough
   * now that a decoration shares one, or pointing at a lamp would read as
   * pointing at the shelf under it and open the wrong menu on the second press.
   */
  isSelected(f) {
    const r = this.fixtureRef;
    if (!r || !f) return false;
    return r.id === f.id || (r.x === f.x && r.z === f.z && r.kind === f.kind);
  }

  /**
   * Turn the ghost a quarter, either way.
   *
   * R only ever went one way, which is fine for a key you tap four times and
   * wrong for a wheel: a wheel has two directions and a control that ignores
   * one of them reads as broken rather than as opinionated.
   */
  rotateBuild(dir = 1) {
    this.buildRot = (this.buildRot + (dir < 0 ? 3 : 1)) % 4;
    // Turning it by hand is the whole signal that you want to choose. Without
    // this the auto-facing would put the ghost straight back the way it was on
    // the very next frame, and R would read as a key that does nothing.
    this.rotPinned = true;
  }

  /**
   * Back to a facing nobody has chosen yet.
   *
   * Every place that resets the angle is a place a *new* choice starts — a tool
   * picked off the palette, the mode opened, the server disarming us — so the
   * pin has to reset with it. Otherwise one press of R twenty shelves ago is
   * still quietly steering the preview, and the auto-facing looks broken in a
   * way nothing on screen explains.
   */
  resetRot() {
    this.buildRot = 0;
    this.rotPinned = false;
  }

  /**
   * Up to the ceiling, or back down.
   *
   * Deliberately NOT reset by `resetRot` or by picking a tool: see `buildDeck`.
   * The one thing that does put you back on the floor is leaving build mode,
   * because a deck you cannot see you are on is the quiet-build-mode bug with a
   * storey on it — every press would land somewhere you were not looking.
   */
  toggleDeck() {
    this.buildDeck = this.buildDeck ? 0 : 1;
    return this.buildDeck;
  }

  /**
   * The quarter turn, for a hand that has no R key and no wheel.
   *
   * Every other build decision is reachable with a finger — what to place, where
   * to put it, and since the aim-hold, which tile exactly — and this one was
   * not, on the one control you need BEFORE the money is spent. Two fingers were
   * already the camera, so there was nowhere left to put it as a gesture: it had
   * to be a button.
   *
   * It shows only where the pill drives (`pillDrives`) and only over a FIXTURE
   * ghost. A wall, a floor and a paint brush have no facing at all, and a button
   * that turns nothing is worse on a small screen than no button — it is the
   * "tier that changes no number" trap wearing a fingertip.
   *
   * Nothing calls `refreshGhost` afterwards, and that is not an omission: build
   * mode re-runs it every frame for the ghost (see the frame loop in main.js).
   * A call from here would be the second opinion, one frame early.
   */
  syncRotate() {
    const el = this.el.rotate;
    if (!el) return;
    const on = pillDrives()
      && (!!this.holding || (this.paletteArmed && !this.armedEdgeTool() && !this.demolishArmed()));
    if (on !== this._rotOn) {
      this._rotOn = on;
      el.classList.toggle('show', on);
    }
    this.syncLeave();
  }

  /**
   * The way out, on the thumb opposite the quarter turn.
   *
   * Same argument as `syncRotate` and a wider test, because leaving is the one
   * thing you want out of *every* build tool rather than out of a fixture ghost:
   * a wall, a floor and a paint brush have no facing to turn and every one of
   * them has a way out. So the tool tests are gone and what is left is "is this
   * mode mine" — `paletteArmed`, plus a lift, since a fixture menu's Move
   * borrows the mode and a shelf in your hands with no visible way to put the
   * mode down is the same complaint one press further in.
   *
   * A borrowed mode nobody was told about shows nothing, which is the point of
   * asking `paletteArmed` rather than `buildOn`: an X floating over a shelf's
   * menu is a button offering to close a mode the player does not know they are
   * in — `releaseMenuMode` is what ends that one, and it ends it by itself.
   */
  syncLeave() {
    const el = this.el.leave;
    if (!el) return;
    const on = pillDrives() && (this.paletteArmed || !!this.holding);
    if (on !== this._leaveOn) {
      this._leaveOn = on;
      el.classList.toggle('show', on);
    }
    this.syncSteps();
    // ...and the camera pair, which hangs off the same chain and off none of the
    // same state. Called from here rather than from `syncSteps`, whose early
    // return would make this depend on the undo stack having moved — true today
    // only because `pillDrives` happens to be in that key.
    this.syncView();
    // ...and beside it rather than inside it, for exactly that reason said one
    // link further along: `syncView` returns early on its own one boolean, so a
    // call from in there would only ever fire on the frame the screen changed
    // width.
    this.syncSelect();
  }

  /**
   * Undo and Redo, under the thumb that owns the way out.
   *
   * `syncLeave`'s test exactly, and deliberately not `syncRotate`'s: a wall, a
   * floor and a paint brush have no facing to turn and every one of them is a
   * press you can want back, so the narrower "over a fixture ghost" would leave
   * the button off for three of the four things it is most for.
   *
   * `.off` rather than `.show` for an empty stack, which is the one judgement
   * call in here. Hiding a Redo the instant you build something new would take
   * the button out from under a thumb already moving toward it — the complaint
   * `#rotbtn`'s own comment settles by pinning it to nothing that can change
   * size. Dimmed, it stays where it was and says why it does nothing.
   *
   * Both counts come off the snapshot rather than being tallied here. The stack
   * is one per SHOP (see `server/sim/undo.js`), so a client keeping its own
   * count would be wrong the moment the other player built anything — and it
   * would be wrong in the direction that offers you a button that does nothing.
   */
  syncSteps() {
    const on = pillDrives() && (this.paletteArmed || !!this.holding);
    // Behind a key, because this runs off the snapshot at 10Hz and the answer
    // moves a handful of times a session — the same guard `syncRotate` and
    // `syncLeave` each keep for their own one boolean.
    const key = `${on}:${!!this.undos}:${!!this.redos}`;
    if (key === this._stepsKey) return;
    this._stepsKey = key;
    for (const [el, n] of [[this.el.undo, this.undos], [this.el.redo, this.redos]]) {
      if (!el) continue;
      el.classList.toggle('show', on);
      el.classList.toggle('off', !n);
    }
  }

  /**
   * The camera pair, which is the one thing in this stack that is not a mode.
   *
   * `pillDrives` and nothing else: turning the view and putting it back are how
   * you look round a shop, not how you build one, and a phone has no `,`, no `.`
   * and no comfortable two-finger twist while a thumb is holding something. They
   * are hidden on a desktop for `#rotbtn`'s reason — a button standing in for
   * keys you already have is clutter over the shop.
   *
   * Neither is ever dimmed. Home with the camera already on you does nothing
   * visible, which is true and is also the wrong thing to say with a control:
   * the whole point of it is that you press it without first working out whether
   * the view has drifted, and a Home that greyed itself out would be asking you
   * to make that judgement before every press.
   */
  syncView() {
    const on = pillDrives();
    if (on === this._viewOn) return;
    this._viewOn = on;
    this.el.view?.classList.toggle('show', on);
    this.el.home?.classList.toggle('show', on);
  }

  /**
   * Pick-several and Remove, which are the two this stack was missing.
   *
   * `syncSteps`' test rather than `syncRotate`'s, and for the same reason: these
   * are about the fixtures already standing in the shop, not about the ghost
   * under your finger — a wall tool and a paint brush are both modes you want to
   * pick a shelf out of.
   *
   * Remove is dimmed rather than hidden when nothing is picked, which is
   * undo/redo's call and made here for a sharper version of the same argument:
   * it is the button a selection is FOR, so a Remove that appeared only once you
   * had picked something would be the thing that tells you the latch worked
   * arriving after you needed to know. Dimmed, it is what the latch is pointing
   * at the whole time.
   *
   * Behind a key like its neighbours: this runs off the snapshot at 10Hz and
   * the answer moves a handful of times a session.
   */
  syncSelect() {
    const on = pillDrives() && (this.paletteArmed || !!this.holding);
    const key = `${on}:${!!this.pickLatch}:${!!this.selectedFixture()}`;
    if (key === this._selKey) return;
    this._selKey = key;
    this.el.pick?.classList.toggle('show', on);
    this.el.del?.classList.toggle('show', on);
    this.el.del?.classList.toggle('off', !this.selectedFixture());
  }

  /**
   * The bottom bar, whichever of the two things is using it.
   *
   * Never both: they are one strip of screen, so turning one on takes it off
   * the other (`showBar`). Everything about *how* a tiered picker behaves —
   * tabs, the sideways scroll, the number keys, scrolling the selection into
   * view, measuring its own height — lives in `bar.js` and is written once.
   * This decides only what is in it.
   */
  renderHotbar() {
    if (!this.el.buildTools) return;
    this.el.build.classList.toggle('on', !!this.bar);
    // The two browse bars have no art to stand in a slot, and an empty well
    // under a glyph reads as a slot with the thing missing out of it.
    this.el.build.classList.toggle('browse', this.bar === 'staff');
    // Nothing up: the bar is still in the document and still has a height, so
    // say zero explicitly. Everything above it in the stack is `calc()` off
    // this, and a stale value floats the panel over empty screen.
    // …and a bar that has gone has taken the hint with it, which is the one
    // moment `renderBuildHint` cannot see for itself: it is not called from here,
    // so without this the "Nothing armed" line would still be marked as read the
    // next time build mode opens, and having closed the bar once would be enough
    // to never see it again.
    // Here as well as on the snapshot, because arming a tool is a press and a
    // press that has to wait up to a tenth of a second for its own button to
    // appear is a button that reads as intermittent.
    this.syncRotate();
    if (!this.bar) { this.forgetHint(); this.measureBar(true); return; }
    const browse = this.browseGroups();
    if (browse) return this.renderBrowseBar(browse, (it) => this.openBarEntry(it), this.litEntry());
    return this.renderBuildBar();
  }

  /**
   * Press one entry of a browse bar.
   *
   * A person opens their own menu — there is a lot to say about somebody who
   * already works here. A kind of person does not: pressing Hire hires, and the
   * tile already says the name and the wage.
   *
   * There were three browse bars and this dispatched all of them. Upgrades left
   * — a tile is 76px and could not say what the thing DOES, which is the only
   * question anybody has about an upgrade — so the roster is what is left.
   */
  openBarEntry(it) {
    if (it.hire) { this.disarmHire(); return showWorker(this, it.hire); }
    if (it.kind) return this.armHire(it.kind);
    this.disarmHire();
    return undefined;
  }

  /**
   * Taking somebody on asks twice.
   *
   * Every other tile in this game either opens something or places something you
   * can sell back. A hire does neither: it is the one press in the UI that spends
   * money with no menu in between and nothing to undo it — letting them go
   * refunds nothing — so the cost of a mis-tap is a wage charged again every
   * morning until you notice. It is also the easiest mis-tap there is, because
   * the tiles sit where the roster's tiles sit and one of those opens a card.
   *
   * The same shape Let go uses in the worker menu, said about the other end of
   * the same decision, and it borrows its window (`ARM_MS`) so the two halves of
   * "this is the irreversible one" behave alike.
   *
   * Armed on the TILE rather than through a dialog: the tile is the target your
   * finger is already on, and a confirm box somewhere else is a second thing to
   * hit. It disarms on a timer, on pressing anything else in the bar, and on the
   * bar going away — an arm that outlived the strip it was drawn on would fire
   * on whatever tile came back in that slot.
   *
   * IT WAS A HOLD FOR ONE STEP, and the trade is worth writing down rather than
   * making twice. A hold is the same protection inside one press with no mode to
   * clear afterwards, which is the whole of what an arm costs — and what it
   * costs in return is the gesture itself: a tap that deliberately does nothing
   * reads as a dead tile, the wait is time you spend on every hire whether or
   * not you meant it, and the tile you are pressing is 76px of the one bar where
   * everything ELSE is a tap that opens something. Two taps are two ordinary
   * presses; a hold is a gesture you have to be told about, which is why it
   * needed a toast and a line in the tip saying so.
   */
  armHire(kind) {
    if (this.hireArm === kind) {
      this.disarmHire();
      return this.net.send('hire', { kind });
    }
    // Cleared without a redraw, because the line under it draws anyway: two
    // renders of one strip is the tile you are pressing rebuilt under your
    // finger, which on touch is a press that can land on the second copy.
    if (this.hireArmAt) clearTimeout(this.hireArmAt);
    this.hireArm = kind;
    this.hireArmAt = setTimeout(() => { this.disarmHire(); }, ARM_MS);
    return this.renderHotbar();
  }

  /** Forget an armed hire, and redraw only if there was one. */
  disarmHire() {
    if (this.hireArmAt) { clearTimeout(this.hireArmAt); this.hireArmAt = null; }
    if (!this.hireArm) return undefined;
    this.hireArm = null;
    return this.renderHotbar();
  }

  /**
   * Which entry the bar draws as the open one. It follows whatever menu is up
   * rather than a selection this object holds — see `renderBrowseBar` — so it
   * is spelled here exactly the way the entries themselves are spelled in
   * `staffGroups` — the only browse bar left.
   */
  litEntry() {
    if (this.openPanel === 'worker') return `hire:${this.workerRef}`;
    // No upgrade branch: pressing one acts rather than opening anything, so
    // there is never an upgrade tile to draw as the open one.
    return null;
  }

  renderBuildBar() {
    const groups = this.buildGroupList();
    // One resolution of which tab, which part of it and what is on it —
    // `openBuildGroup` already writes back a tab that resolved to something
    // other than what was remembered, which is what `renderBar` would otherwise
    // be asked to work out a second time.
    const open = this.openBuildGroup(groups);
    const { group, sub } = renderBar(this.barEl(), {
      groups,
      at: open.group?.id ?? null,
      atSub: open.sub?.id ?? null,
      picked: this.toolId(),
      // Shapes are not palette entries of their own — a corner shelf is a shelf,
      // at a shelf's price, and the number keys should keep meaning one fixture.
      choice: {
        // Asked for rather than standing: it floats over the world now, so it is
        // up while you are choosing and gone the rest of the time.
        open: this.shapesOn,
        // Each shape wearing its own shape. A corner unit and a straight one are
        // the same word in two spellings otherwise, which is the thing a picture
        // is actually for.
        options: variantsOf(this.catalog.fixtures?.find((x) => x.id === this.buildPiece))
          .map((v) => ({ ...v, art: artForVariant(v) })),
        picked: this.buildVariant ?? '',
        onPick: (id) => { this.commitBuildMode(); this.selectBuildVariant(id); },
      },
      onTab: (id) => this.selectBuildGroup(id),
      onSubTab: (id) => this.selectBuildSub(id),
      // Pressing the lit one puts it down, which is the other half of an empty
      // hand being a real state: the button that armed it is the button anybody
      // reaches for to unarm it, and a palette where the only way out is a key
      // is a palette you cannot put down with the mouse you armed it with.
      //
      // `toolId` rather than a stored flag, so this asks the same question the
      // lit ring on the button answers — press what is lit and it goes out.
      onPick: (t) => {
        if (this.toolId() === t.id) { this.disarmTool(); return; }
        this.commitBuildMode();
        this.selectBuildTool(t.id);
      },
      // Holding a tile, or pressing its chevron. Arms it first when it isn't the
      // one that is armed — you cannot be asking about the shapes of a shelf and
      // not be asking for a shelf — and `selectBuildTool` restores whichever
      // shape you last chose for it, so the card opens on the answer you gave
      // last time rather than on Standard.
      onShapes: (t) => {
        this.commitBuildMode();
        const same = this.toolId() === t.id;
        if (!same) this.selectBuildTool(t.id);
        this.toggleShapes(same ? !this.shapesOn : true);
      },
    });
    this.barTab.build = group?.id ?? null;
    if (group && sub) this.barSub[group.id] = sub.id;
    // Measures the bar itself, so it goes last.
    this.renderBuildHint();
    return undefined;
  }

  /**
   * The same bar, browsing rather than arming.
   *
   * A person and an upgrade are both picked the way a fixture is — press the one
   * you mean and its own menu opens — and neither leaves anything armed
   * afterwards. That is the whole difference from the build bar: pressing one of
   * these is opening a door, not picking up a tool, so `picked` follows whatever
   * menu is open rather than a selection this object is holding.
   *
   * An upgrade in particular has to go through its own menu: a bar entry is one
   * press, and one press is the wrong amount of ceremony for a permanent,
   * unrefundable twenty thousand dollars.
   */
  renderBrowseBar(groups, onPick, picked) {
    const { group } = renderBar(this.barEl(), {
      groups,
      at: this.barTab[this.bar],
      picked,
      choice: null,
      onTab: (id) => { this.barTab[this.bar] = id; this.renderHotbar(); },
      onPick,
    });
    this.barTab[this.bar] = group?.id ?? null;
    this.renderBuildHint();
    return undefined;
  }

  /**
   * The four elements `bar.js` draws into. A browse bar has no sub-tabs and no
   * choice row, and both are hidden rather than absent: one strip of screen
   * means one set of elements, and a bar that swapped its own markup would have
   * to put the height back too.
   */
  barEl() {
    return {
      groups: this.el.buildGroups,
      subs: this.el.buildSubs,
      // What those two scroll inside. Same shape as `strip` below and not drawn
      // into: the nav row is content-width, so a tab with sub-tabs on it runs
      // off a phone with no way to drag it back.
      tabs: this.el.buildTabs,
      items: this.el.buildTools,
      // The strip's frame and its two ends. Not drawn into — they are what the
      // entries scroll *inside* — so they are handed over once and `bar.js`
      // wires them rather than rebuilding them on every render.
      strip: this.el.buildStrip,
      back: this.el.buildBack,
      on: this.el.buildOn,
      // The bulldozer, which is pinned rather than scrolled — see `renderBar`.
      raze: this.el.buildRaze,
      choice: this.el.buildShapes,
    };
  }

  /**
   * Give the bottom bar to one of its two users, or to nobody.
   *
   * Build mode is a state of the *world* — a ghost on the ground, taps that
   * place instead of walk — so it owns the bar rather than the other way round:
   * showing the roster leaves build mode, because a bar you cannot see is a mode
   * you cannot see you are in, and that is the whole complaint the rail's lit
   * Build button answers.
   */
  showBar(which) {
    if (this.bar === which) return;
    // Handing the strip to somebody ELSE leaves build mode. Putting it away
    // does not, and that distinction is the whole of the second press: build
    // mode with the palette down is the state you drag things about in, so
    // `showBar(null)` out of it must leave the mode standing.
    if (which && which !== 'build' && this.buildOn) { this.toggleBuild(false, { quiet: true }); }
    // ...but it does take whatever was armed with it. `toolArmed` no longer asks
    // about the bar (see `paletteArmed`), so a shelf left armed under a palette
    // you have just closed is a tap on the floor that buys one, out of a mode
    // with nothing on screen saying what it is holding — which is the exact bug
    // `paletteArmed` was written for, wearing the other hat.
    if (this.bar === 'build' && which !== 'build') this.disarmTool();
    // A menu opened FROM a bar goes with it. A hire's sheet is a tile of the
    // strip underneath expanded — `openBarEntry` is the only thing that opens
    // one — so a bar that closes and leaves it behind has left a window onto a
    // list you can no longer see, floating over the shop with nothing to shut it
    // but a second press somewhere else. It was two of these; an upgrade tile
    // opens nothing at all now.
    //
    // A fixture menu is the exception. It is about something standing in the
    // world and outlives every bar on purpose: opening the palette to move the
    // shelf you were just reading about must not close what you were reading.
    // ...and an armed hire goes with it, for the reason `disarmTool` above does:
    // an arm that outlived the strip it was drawn on would fire on whatever tile
    // came back in that slot.
    if (this.hireArm) { clearTimeout(this.hireArmAt); this.hireArmAt = null; this.hireArm = null; }
    if (this.openPanel === 'worker') this.closePanel();
    this.bar = which;
    this.rail.setBar(which);
    this.renderHotbar();
  }

  toggleBar(which) {
    this.showBar(this.bar === which ? null : which);
  }

  /** The tabs, in palette order, dropping any nobody has authored anything for. */
  buildGroupList() {
    return buildGroups(this);
  }

  /**
   * The open tab of the build bar, its open sub-tab, and the entries actually in
   * front of you — resolved against what exists, since a remembered tab can stop
   * existing (the last floor design is deleted, nobody has authored a machine).
   *
   * `items` is the leaf's rather than the group's, because everything that asks
   * this question — the number keys, "is the armed tool on screen" — is asking
   * about what is drawn, and a split group never draws its own flat list.
   */
  openBuildGroup(groups = this.buildGroupList()) {
    const group = groupAt(groups, this.barTab.build);
    this.barTab.build = group?.id ?? null;
    const sub = group?.subs ? groupAt(group.subs, this.barSub[group.id]) : null;
    if (group && sub) this.barSub[group.id] = sub.id;
    return { group, sub, items: (sub ?? group)?.items ?? [] };
  }

  selectBuildGroup(id) {
    if (id === this.barTab.build) return;
    this.barTab.build = id;
    // Opening a tab is browsing, not choosing — the armed tool is whatever you
    // last picked until you pick another, so the ghost doesn't change under you.
    this.renderHotbar();
  }

  selectBuildSub(id) {
    const { group } = this.openBuildGroup();
    if (!group || this.barSub[group.id] === id) return;
    this.barSub[group.id] = id;
    this.renderHotbar();
  }

  /**
   * Every stop the tab key makes, in order: a split group offers its sub-tabs
   * and not itself. Tab means "the next set of buttons", and stopping on a
   * Building that immediately redirects you to Walls is a press that changes
   * nothing you can see.
   */
  buildStops() {
    return this.buildGroupList().flatMap((g) => (g.subs
      ? g.subs.map((s) => ({ id: `${g.id}/${s.id}`, group: g.id, sub: s.id }))
      : [{ id: g.id, group: g.id, sub: null }]));
  }

  /** Round the tabs, for the key that cycles them. Whichever bar is up. */
  cycleBuildGroup(dir = 1) {
    // Whichever bar is up says which tabs there are, and `barTab[this.bar]` is
    // the one field that says which of them is open — it is what
    // `renderBrowseBar` draws from. The roster kept a second idea of the same
    // thing (`staffGroup`), which the bar never read, so Tab moved a field
    // nothing drew and the key read as dead; Upgrades had no branch at all and
    // so cycled the BUILD tabs, invisibly, from a bar with none of them on it.
    const browse = this.browseGroups();
    if (browse) {
      this.barTab[this.bar] = nextGroup(browse, this.barTab[this.bar], dir);
      this.renderHotbar();
      return;
    }
    const stops = this.buildStops();
    const { group, sub } = this.openBuildGroup();
    const here = group ? `${group.id}${sub ? `/${sub.id}` : ''}` : null;
    const to = stops.find((s) => s.id === nextGroup(stops, here, dir));
    if (!to) return;
    this.barTab.build = to.group;
    if (to.sub) this.barSub[to.group] = to.sub;
    this.renderHotbar();
  }

  /**
   * The line above the bar, and only when it has news.
   *
   * It used to carry a standing "tap bare ground to build a shelf" whenever
   * nothing else was happening, which is most of the time — a permanent line
   * restating the button already lit up beside it, sitting on the bottom edge of
   * the screen and holding the rest of the HUD up. What is left is the three
   * things the bar cannot show you: what is in your hands, what you are pointing
   * at, and what a tap is about to cost you.
   */
  /** Forget that a lingering line has been shown, so the next one starts over. */
  forgetHint() {
    clearTimeout(this._hintTimer);
    this._hintTimer = null;
    this._hintKey = null;
    this._hintDone = false;
  }

  renderBuildHint() {
    if (!this.el.buildHint) return;
    const say = this.buildHintText();
    // A `linger` line is one that has been read by the time it has been up for
    // a few seconds. Keyed by its own text rather than by a flag, so the timer
    // starts when the line APPEARS and re-arms every time the state is entered
    // again — arming a tool clears the line, and disarming brings the same words
    // back as a new appearance rather than as the tail of the last one.
    //
    // The timeout has to re-render rather than just hide, or the bar keeps the
    // height it had with the line in it (`measureBar`) and the corner HUD floats
    // above a gap.
    const key = say?.linger ? say.text : null;
    if (key !== (this._hintKey ?? null)) {
      this.forgetHint();
      this._hintKey = key;
      if (key) {
        this._hintTimer = setTimeout(() => {
          this._hintDone = true;
          this.renderBuildHint();
        }, HINT_LINGER);
      }
    }
    const show = say && !(say.linger && this._hintDone);
    // Only written on the way IN. It slides out over about a fifth of a second
    // (`#build-hint.gone`), and a box emptied of its words on the first frame of
    // that is a blank bubble shrinking — the animation exists to show the line
    // leaving, so the line has to still be in it. Same for the two colours: a
    // refusal that went grey as it left would flicker on its way out.
    if (show) {
      this.el.buildHint.textContent = say.text;
      this.el.buildHint.classList.toggle('warn', !!say.warn);
      this.el.buildHint.classList.toggle('bad', !!say.bad);
    }
    this.el.buildHint.classList.toggle('gone', !show);
    // `followBar` rather than `measureBar`: the height this changes takes a fifth
    // of a second to arrive, and one read now is the height it had before.
    this.followBar();
  }

  buildHintText() {
    // The roster bar arms nothing, so it has no ghost and no warning to give —
    // and it no longer needs to say there is nobody working here, because the
    // Hire tab is the bar when the roster is empty and it is a list of people
    // with prices on. What it cannot say for itself is a shop with no `workers`
    // rows at all: an empty tab under an empty roster reads as a bar that
    // failed to load rather than as a game nobody has authored a worker for.
    if (this.bar === 'staff') {
      return (this.catalog.workers ?? []).length
        ? null
        : { text: 'Nobody has authored a kind of worker — there is no one to hire' };
    }
    if (this.holding) {
      // The turn is named differently in the two grammars because it IS a
      // different control — R and the wheel on a mouse, the round button by the
      // bar on a finger. Naming a key at somebody holding a phone is the same
      // failure the tour's `perInput` exists for.
      const turn = pillDrives() ? 'the turn button' : 'R or the wheel';
      return { text: `Carrying a ${this.holding.label.toLowerCase()} — tap a tile to set it down · ${turn} turns it · Esc puts it back` };
    }
    // ...and the same claim about the modifier that does the same job. Above the
    // bulldozer and above everything else in here for the reason `refreshGhost`
    // reads Shift first: it outranks whatever is armed, so a line describing the
    // armed tool over a red frame would be the copy disagreeing with the world.
    // The words are `razeSay`'s, because the sentence has to name the target and
    // this side does not know which of the four kinds it is.
    if (this.razeAim) return { text: this.razeAim, warn: true };
    // Aiming a bulldozer at something is not looking at it, and the line that
    // says "tap to open it" over a thing a tap would delete is the one piece of
    // copy here that could actually cost somebody a shop.
    if (this.aimed && this.demolishArmed()) {
      return { text: `Tear out the ${this.fixtureName(this.aimed).toLowerCase()} — tap it`, warn: true };
    }
    // Nothing about the thing under the pointer. That whole sentence — the name
    // and which press does what to it — is the pill's now (`hints.about` and the
    // rows beside it in `pressHints`), and the pill says it better: each verb is
    // a button you can actually press, and it works on a phone, where R and M
    // do not exist to be named in prose.
    //
    // This line used to carry it, and for one step it carried it TOO: the name
    // arrived in the pill without leaving here, so a shelf under the pointer
    // said "Shelving" twice, a few pixels apart, in two different colours. Two
    // surfaces at the bottom of the screen naming one shelf is not redundancy
    // you read past — it reads as one of them being a bug.
    //
    // The demolish warning above stays, and the split is the useful part: that
    // one is not a NAME, it is what the armed tool would do to the thing, which
    // is the one fact about an aimed fixture the pill's rows cannot carry.
    // Empty hands, which is where the mode starts. Says so, because a bar with
    // nothing lit and no ghost under the pointer is otherwise indistinguishable
    // from a mode that has stopped working — and it is the one state in build
    // mode with nothing on screen to explain itself.
    //
    // It used to carry the drag as well, and that half has moved a press earlier
    // (`Rail.note`): dragging things about is what the mode with NO palette is
    // for, so saying it again over the open palette is the one line here telling
    // you about somewhere you are not. What is left is the question this line is
    // actually the answer to — the bar is up, and nothing on it is lit.
    //
    // `linger`, because this one is an introduction rather than an answer: it is
    // true for as long as you have not picked anything.
    //
    // The selection used to be named here too, on the argument that `aimed` is a
    // hover and a picked unit outlives the pointer. The pill answers that from
    // the same two places in the same order (`about` in main.js: the aim first,
    // then `fixtureRef`), so keeping it here was the same name in two boxes
    // whether you were pointing at the unit or had walked away from it.
    if (this.paletteArmed && !this.toolArmed) {
      // ...and the one gesture in the mode that nothing else on screen mentions.
      // Shift is invisible until something reacts to it, and what reacts to it is
      // the red frame you only see once you are already holding the key — so the
      // only place it can be learned is a line you read before pressing anything.
      return {
        text: 'Nothing armed — pick something below to build it · hold Ctrl to demolish, Shift to select',
        linger: true,
      };
    }
    const v = this.buildVerdict;
    // A red ghost is a refusal, and the reason is the only thing that turns it
    // from "nothing happened" into "not there".
    if (v && !v.ok) return { text: v.reason, bad: true };
    // An amber ghost means it will land and cost you something. Saying what,
    // before the tap rather than after it, is the whole point of the colour.
    if (v?.warn) {
      return {
        text: `${v.warn} — tap anyway if you meant it · ${pillDrives() ? 'the turn button' : 'R'} rotates`,
        warn: true,
      };
    }
    return null;
  }

  /**
   * How far in — and on a narrow screen, how far down — the to-do chips have to
   * start, so they clear the readouts.
   *
   * The horizontal twin of `measureBar`, and it exists for the same reason that
   * one does: the left-hand column has no fixed width, so a stylesheet that
   * names one is naming today's. `#hq` carried `calc(100vw - 360px)` for exactly
   * as long as nobody played on a narrow screen — see the note on `#hq`.
   *
   * A `ResizeObserver` and not a call at the end of `update`, because almost
   * everything that changes this width is invisible from here: the cash crossing
   * a digit, a season word of a different length, the demand meter gaining a
   * row, the radio's track title. Watching the box itself is the only version
   * that cannot be forgotten by the next thing added to that column.
   *
   * `offsetWidth` rather than the observer's own `contentRect`, which excludes
   * padding and would leave the chips overlapping the card's last few pixels.
   * The gap is the same 12 the corner uses everywhere, so the chips sit off the
   * card by as much as the card sits off the screen.
   *
   * Guarded on the API existing at all: this is the only layout observer in the
   * client, and a browser without one should lose the fine-tuning rather than
   * the HUD. The CSS fallback (`var(--hq-left, 12px)`) is then simply the whole
   * width, chips centred over everything — which is where they were before any
   * of this, so the worst case is today's behaviour.
   */
  watchTopLeft() {
    const box = document.getElementById('topleft');
    const bar = document.getElementById('stats');
    if (!box || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const css = document.documentElement.style;
      css.setProperty('--hq-left', `${12 + box.offsetWidth + 12}px`);
      // ...and how far DOWN they have to start, which is the same question on
      // the other axis and only has an answer on a narrow screen: under 640px
      // the card is a full-width bar across the top (see the query at the foot
      // of index.html), so there is no width left to clear and the clearance is
      // its height. It wraps onto a second line when the shop grows a longer
      // season word or a fifth digit, so this is a measurement for exactly the
      // reason the width is one. Published always rather than behind a
      // `matchMedia`: the var costs nothing where nothing reads it, and a
      // second place that has to be told which layout is up is a second place
      // that can disagree with the stylesheet about it.
      //
      // #stats and not #topleft, because the column also holds the meter and
      // the radio and the chips only have to clear the bar. Observing the
      // column alone is enough to see this change — the bar is a child of it,
      // so a bar that grows a line grows the column.
      if (bar) css.setProperty('--hud-h', `${bar.offsetHeight}px`);
    };
    this._topLeftObs = new ResizeObserver(measure);
    this._topLeftObs.observe(box);
    measure();
  }

  /**
   * How tall the bar is, for the corner HUD to sit above.
   *
   * Measured rather than written into the stylesheet because the bar grows and
   * shrinks — a shapes row appears, the hint comes and goes — and a number
   * guessed at here is one that goes wrong the day a tier is added.
   */
  measureBar(empty = false) {
    const h = empty ? 0 : (this.el.build?.offsetHeight ?? 0);
    document.documentElement.style.setProperty('--build-h', `${h}px`);
  }

  /**
   * ...and how tall the PILL is, for the same reason and only on a phone.
   *
   * On a desktop these two never meet: the pill is a narrow caption in the middle
   * and your hands are a card in the right-hand corner, so they share a `bottom`
   * and nothing collides. On a touchscreen the pill's rows are buttons, which
   * makes it a full-width stack — and a full-width stack at the same `bottom` as
   * the carry card draws straight over it. What you lose is exactly the half you
   * need while the pill is offering to put something down: what you are holding.
   *
   * Measured, like the bar, because a pill is one row or four depending on what
   * you tapped — a literal here would be right for one of those and wrong for the
   * rest, which is the trap `measureBar`'s own note describes.
   */
  measurePill() {
    // Only while it is up: `#prompt` keeps its box when hidden, and reserving
    // room for a pill nobody can see would float the carry card in mid-air.
    const up = this.el.prompt?.classList.contains('show');
    const h = up ? (this.el.prompt?.offsetHeight ?? 0) : 0;
    document.documentElement.style.setProperty('--pill-h', `${h}px`);
  }

  /**
   * Keep measuring while the bar is still changing size.
   *
   * `measureBar` reads a height, and the hint now takes about a fifth of a second
   * to get to its own (`#build-hint`), so one read taken the instant the class
   * flips is the height the bar had *before* — and the panel and the corner HUD
   * are positioned off that number. Read once and they never move; read once at
   * the end and they jump to their new place a fifth of a second late, which is
   * the snap this animation was added to get rid of, moved somewhere else.
   *
   * So it follows: a frame at a time for as long as the transition lasts, and
   * everything above the bar rides up with the hint rather than being told where
   * to be afterwards. Cheap — about a dozen frames, one layout read each, and
   * nothing at all the rest of the time.
   *
   * A clock rather than "stop once the height stops changing", which is the
   * version to reach for first and is wrong: `offsetHeight` is a whole number, so
   * a slow frame or the shallow end of an eased curve holds the same integer for
   * two or three frames in the middle of the animation, and the loop gives up
   * there — leaving `--build-h` at a height the bar passed through.
   *
   * Stops dead if the bar goes: a closed bar still has a height, which is exactly
   * why `renderHotbar` says zero explicitly rather than measuring, and a loop
   * still running would write that height straight back over it.
   */
  followBar() {
    cancelAnimationFrame(this._barFrame ?? 0);
    const until = performance.now() + BAR_SETTLE;
    const step = (now) => {
      if (!this.bar) { this.measureBar(true); return; }
      this.measureBar();
      if (now < until) this._barFrame = requestAnimationFrame(step);
    };
    step(performance.now());
  }

  /**
   * What the tile under the pointer would do to you, in the ghost's own words.
   *
   * Both halves of `canPlace`, not just one. It used to take the warning only,
   * so a *refusal* had no words anywhere near the pointer — the red ghost was
   * the whole message, and the reason went to a toast at the top of the screen.
   * That was survivable while the palette lived up there too. It stopped being
   * survivable the day the bar moved to the bottom: you click at the bottom, the
   * answer appears six hundred pixels away for two and a half seconds, and what
   * you experience is a game that ignores you.
   */
  setBuildVerdict(v) {
    const key = v && !v.ok ? `no:${v.reason}` : (v?.warn ? `warn:${v.warn}` : null);
    if (key === (this._verdictKey ?? null)) return;
    this._verdictKey = key;
    this.buildVerdict = key ? v : null;
    if (this.bar) this.renderBuildHint();
  }

  // `buildVariantName` retired here. It named the chosen shape in the standing
  // hint, which was the only place on screen that said which one was armed —
  // the shapes row on the bar lights it now, in the place you picked it.

  /**
   * The fixture the open menu is about, and the teal ring in the world that
   * says which one it is.
   *
   * One setter rather than an assignment at each of the three places that
   * change it, because the ring and the panel must never disagree: a ring left
   * behind is pointing at a menu that closed, which is worse than no ring at
   * all. Pass null for "no fixture menu open".
   */
  setFixtureRef(f, { keepPicked = false } = {}) {
    this.fixtureRef = f;
    // Picking a different thing starts a different selection. That is the rule
    // every multi-select in every program works to, and it is the only one that
    // makes an ordinary tap safe: without it, opening a shelf to look at it
    // would quietly add it to six units you had picked ten minutes ago and the
    // next thing you pressed would happen to all seven.
    //
    // `keepPicked` is for the one press that means the opposite — shift, which
    // is the whole gesture (`togglePicked`) — and for a re-flow re-pointing the
    // ref at the same fixture's new id.
    if (!keepPicked) this.picked = [];
    this.scene?.setSelectedTarget(f, f ? this.markerSpots(f) : null);
    this.syncPickMarkers();
    // The standing hint names which of the two presses you are on, and picking
    // something changes that answer without the pointer moving — which is
    // exactly what `setAim` cannot see, since it early-returns on the same id.
    // Without this the line under a shelf you just picked still says "tap to
    // pick it", over a ring saying you already have.
    if (this.buildOn) this.renderBuildHint();
  }

  /**
   * Add a fixture to the selection, or take it back out — the shift-click.
   *
   * The FIRST one is the ref, not a member of the list. That asymmetry is worth
   * stating because it is what keeps the whole feature cheap: the menu, the
   * ring, R, M and every verb that was written against one fixture go on being
   * written against one fixture, and `picked` is the extras. Shift-clicking the
   * ref itself is how you back out to a plain selection, which is also what
   * makes the gesture reversible in both directions.
   *
   * Refs rather than records, and by tile as well as id, for the reason
   * `refreshFixture` gives: a re-flow re-mints ids, and a bulk restyle is a
   * re-flow — so a selection held by id alone would empty itself the moment you
   * used it.
   */
  togglePicked(f, { quiet = false } = {}) {
    if (!f) return;
    // Nothing picked yet: the first shift-click is an ordinary pick, so shift
    // is never a key you have to press twice to start with.
    if (!this.fixtureRef) { this.selectFixture(f); return; }
    if (this.isSelected(f)) {
      // Backing out of the one the menu is about. The first extra takes its
      // place rather than the whole selection collapsing — you meant to drop
      // that unit, not the other five.
      const [next, ...rest] = this.picked;
      this.setFixtureRef(next ? this.liveRef(next) : null, { keepPicked: true });
      this.picked = next ? rest : [];
      if (!quiet) this.settlePicked();
      return;
    }
    const at = this.picked.findIndex((r) => refIs(r, f));
    if (at >= 0) this.picked.splice(at, 1);
    else this.picked.push({ id: f.id, x: f.x, z: f.z, kind: f.kind });
    if (!quiet) this.settlePicked();
  }

  /**
   * A whole box of them at once — what the marquee drag calls.
   *
   * `bulkFixtures`' argument said on this side of the wire: eleven shelves in
   * one drag must not be eleven redraws of a menu whose length is every item in
   * the catalogue, and it must not be eleven rebuilds of the marker set either
   * (`setMarkedSet` keys on the whole set, so each one is the full list). It is
   * one gesture, so it settles once.
   */
  pickMany(list) {
    if (!list?.length) return;
    for (const f of list) this.togglePicked(f, { quiet: true });
    this.settlePicked();
  }

  /**
   * What every way of changing the selection ends with.
   *
   * Written once because the three of them have to agree: the rings on the shop
   * floor, the menu that says how many, and the thumb button that acts on them.
   * A caller that did two of the three is a shop showing four frames over a
   * menu that says six.
   */
  settlePicked() {
    this.syncPickMarkers();
    // ...and the SECOND one opens the menu, which is the half that was missing.
    //
    // The bulk verbs live nowhere else — Remove, the ladder, what a unit is kept
    // for — and there was no press that reached them: shift-click is consumed
    // whole (`pointerdown` returns before the tap), and the ordinary two-press
    // route to a menu goes through `selectFixture`, which clears the selection
    // on its way. So six shelves picked was six shelves you could look at and
    // not act on, and what that reads as is the popover refusing to open.
    //
    // At two rather than at one, and the line is the existing rule rather than a
    // preference: with one picked this is an ordinary fixture selection and "the
    // first press picks, the second opens" still holds. With two the menu stops
    // being about a shelf and starts being the only place the selection can be
    // used, so waiting for a press that cannot be made is waiting for nothing.
    // ...and NOT on a phone, where the panel is the whole screen: opening it on
    // the second pick would cover the aisle you are still picking from, so the
    // moment there is one is when you let the latch go — see the pick button's
    // own press in `wire`.
    if (!pillDrives() && this.manyPicked && this.openPanel !== 'fixture') {
      showFixture(this, this.fixtureRef);
    } else this.repaintFixtureMenu();
  }

  /**
   * Every fixture picked, live off the layout, the ref first.
   *
   * Resolved on every read rather than stored, exactly as `selectedFixture` is,
   * and anything that has since gone drops out silently — a shelf somebody else
   * removed, a placement a re-flow could not honour. A selection that held dead
   * records would send a bulk verb ids the shop has never heard of, and the
   * count in the menu would be a promise about fixtures that are not there.
   */
  pickedFixtures() {
    const first = this.selectedFixture();
    if (!first) return [];
    const rest = this.picked.map((r) => this.liveRef(r)).filter(Boolean);
    return [first, ...rest.filter((f) => f.id !== first.id)];
  }

  /** ...and just their ids, which is what a bulk message carries. */
  pickedIds() {
    return this.pickedFixtures().map((f) => f.id);
  }

  /** Is more than one thing picked? The test every bulk row is gated on. */
  get manyPicked() {
    return this.picked.length > 0 && this.pickedFixtures().length > 1;
  }

  /**
   * One held ref, resolved against the shop as it stands now.
   *
   * Tile first and id second — the same order and the same reason
   * `refreshFixture` states: the generator re-mints `shelf-p0` positionally on
   * every re-flow, so an id lookup can quietly land on a completely different
   * shelf.
   */
  liveRef(r) {
    if (!r) return null;
    return this.scene?.allFixtures().find((f) => f.x === r.x && f.z === r.z && f.kind === r.kind)
      ?? this.scene?.fixtureById(r.id)
      ?? null;
  }

  /**
   * Which design a fixture is — what "the same thing as this one" means.
   *
   * The PIECE, not the kind and not the shape. That is the set that shares one
   * list of shapes (`variantsOf` reads the piece), so it is exactly the set a
   * bulk restyle can act on: every basic shelf in the shop lights up whether it
   * is currently straight, a corner or a wall unit, because turning all of them
   * into wall units is the thing you are here to do. An appliance falls back to
   * its `station`, the same shrug `pieceOf` makes in the renderer — two toasters
   * are the same thing and a toaster and a fryer are not.
   */
  designOf(f) {
    if (!f) return null;
    // Through `pieceFor`, never off `f.piece` — that is the one that makes an
    // *unpieced* fixture answer the same as one that names the kind's default
    // row. Every fixture in a shop built before the catalog split has no
    // `piece` at all and resolves to exactly the row the ones beside it name, so
    // reading the raw field would sort a shop's own shelving into two designs
    // that draw identically. `kindOf` is the fallback for a kind nobody has
    // drawn a row for, the same shrug the renderer makes.
    const piece = pieceFor(this.catalog?.fixtures ?? [], f);
    return `${f.kind}/${piece?.id ?? kindOf(f) ?? ''}/${f.kind === 'station' ? f.station ?? '' : ''}`;
  }

  /** Everything in the shop that is the same design as the picked one. */
  kinOfSelection() {
    const first = this.selectedFixture();
    if (!first) return [];
    const want = this.designOf(first);
    return (this.scene?.allFixtures() ?? []).filter((f) => this.designOf(f) === want);
  }

  /**
   * Hold Shift and the shop shows you what else is like this one.
   *
   * A preview and nothing else: the key selects nothing, it says what a
   * shift-click would be able to reach. Which is the half that makes the gesture
   * discoverable at all — shift-click is invisible until something on screen
   * reacts to the shift.
   */
  setKinPreview(on) {
    this.shiftPeek = !!on;
    this.syncKin();
  }

  /**
   * The same thing said by a button, because a phone has no Shift.
   *
   * A LATCH rather than a modifier, which is not a compromise — it is what a
   * modifier has to become when there is no second hand free to hold one. While
   * it is down a tap adds or drops a fixture instead of opening it, which is
   * `pointerdown`'s shift branch reading `ui.pickLatch` beside `e.shiftKey`.
   *
   * Two things follow from it being a latch. It has to be VISIBLE — `#pickbtn`
   * is the one button in that stack with an on look, because a latch you cannot
   * see the state of is a mode, and a mode nothing announces is the complaint
   * `paletteArmed` exists to settle for the palette. And it has to be let go of
   * by leaving build mode, or the shop next time you open the bar is one where
   * tapping a shelf mysteriously does not open it.
   *
   * The kin preview comes with it for the same reason it comes with Shift: the
   * gesture is invisible until something on screen reacts to it.
   */
  togglePickLatch(on = !this.pickLatch) {
    if (!!this.pickLatch === !!on) return;
    this.pickLatch = !!on;
    this.el.pick?.classList.toggle('on', this.pickLatch);
    this.el.pick?.setAttribute('aria-pressed', String(this.pickLatch));
    this.syncKin();
    this.syncSelect();
  }

  /**
   * ...and the one answer both of them feed, because either can be true alone.
   *
   * Written as a recompute rather than as two setters for the reason
   * `clampPan` is one function: two writers of one field fight, and what that
   * looks like here is the preview going out the moment you let go of a Shift
   * you were not holding.
   */
  syncKin() {
    const want = (!!this.shiftPeek || !!this.pickLatch) && !!this.fixtureRef;
    if (this.kinOn === want) return;
    this.kinOn = want;
    this.syncPickMarkers();
  }

  /**
   * ...and the other thing Shift does — what a click would get rid of, in words.
   *
   * A string rather than a target, because the four things Shift can be aimed at
   * are a fixture, a finish, a wall and a cell of ground, and only one of them is
   * a record this side has ever heard of. `razeAim` in main.js owns the aim and
   * `razeSay` owns the sentence; this holds the answer for the one line that
   * prints it.
   *
   * A setter rather than an assignment for `renderBuildHint`'s sake: the hint is
   * drawn on state changes, and the pointer moving over a wall is not one of
   * them — so a line written straight onto the field would appear a frame late
   * and, worse, stay up after the key came back off.
   */
  setRazeAim(text) {
    const want = text ?? null;
    if ((this.razeAim ?? null) === want) return;
    this.razeAim = want;
    this.renderBuildHint();
  }

  /**
   * Put both sets of rings where they belong.
   *
   * Called from every place either answer can change — a pick, the ref moving,
   * Shift going down or up, and a layout landing. `setMarkedSet` keys on the
   * whole set, so calling it when nothing has moved costs a string compare.
   *
   * The picked extras wear the `selected` look, because they ARE selected —
   * the ref is only first among them, and a different marker would be the world
   * disagreeing with the menu about how many things you have picked.
   */
  syncPickMarkers() {
    if (!this.scene) return;
    const picked = this.pickedFixtures().slice(1);
    this.scene.setMarkedSet('picked', picked.map((f) => ({
      f, mode: 'selected', spots: this.markerSpots(f),
    })));
    // Never under the ones already picked: the same square wearing two frames
    // reads as a third state, and the thin one is the one that would win.
    const taken = new Set(this.pickedFixtures().map((f) => f.id));
    this.scene.setMarkedSet('kin', this.kinOn
      ? this.kinOfSelection().filter((f) => !taken.has(f.id)).map((f) => ({ f, mode: 'kin' }))
      : []);
    // ...and the thumb button that acts on this selection, here rather than only
    // on the snapshot: every caller of this is a press, and a Remove that stayed
    // dim for a tenth of a second after you picked something reads as the tap
    // having missed. It keys on its own answer, so this costs a compare.
    this.syncSelect();
  }

  /** Redraw the fixture menu if one is open — the selection changed under it. */
  repaintFixtureMenu() {
    if (this.openPanel === 'fixture' && this.fixtureRef) showFixture(this, this.fixtureRef);
  }

  /**
   * The hire the open menu is about, and the teal ring on the shop floor that
   * says which one.
   *
   * The same setter-rather-than-assignment rule `setFixtureRef` states, and a
   * hire needs it more than a fixture does: a shelf whose ring was left behind
   * is at least still the shelf you were reading about, where a hire walks off
   * and the ring goes with them — so a stale one ends up over somebody working
   * two aisles away, for reasons nobody can reconstruct.
   *
   * By roster id, because bodies are re-sent whole ten times a second.
   */
  setWorkerRef(id) {
    const was = this.workerRef ?? null;
    this.workerRef = id ?? null;
    if (was === this.workerRef) return;
    this.scene?.setPersonSelected(this.workerRef);
    // ...and the tile on the bar lights NOW rather than whenever the roster
    // next moves. `litEntry` reads this field, but the strip is only rebuilt
    // when its own signature changes (`_staffKey`: names, jobs, hands, cash) —
    // and pressing a different bot changes none of those. On a quiet shop where
    // every hire says "looking for something to do" that is not a short delay,
    // it is until somebody picks something up: you press one card, nothing
    // lights, and the press reads as dropped.
    this.renderHotbar();
  }

  /**
   * Follow the SELECTION through a re-flow, the way `refreshFixture` follows
   * the menu.
   *
   * Selection and the menu stopped being one fact the day the first press
   * picked a thing without opening it — and only the menu ever learned to
   * follow its fixture. `fixtureRef` is a record out of the snapshot that
   * turned it, so with nothing open, R re-minted the placement, the shop drew
   * the till the new way round, and the teal marker went on describing the old
   * one: the working spots are the only part of it that moves, so what you see
   * is a fixture rotating with its two rings nailed to the floor. The one press
   * where that matters is the one press the marker exists for.
   *
   * Tile first, id second, for the reason spelled out in `refreshFixture`: a
   * rotation re-mints the id, and the generator re-uses the freed name on the
   * next re-flow.
   *
   * @param {Array<object>} fixtures The fresh layout.
   */
  refollowSelection(fixtures) {
    // The menu's own refresh already re-points the ref (`showFixture` calls
    // this class's setter), so this is the case it cannot see: picked, not
    // opened. Two of them running would be a no-op — the marker is keyed —
    // but only one of them can decide what a missing fixture means.
    if (!this.fixtureRef || this.openPanel === 'fixture') return;
    const at = this.fixtureRef;
    // `keepPicked`, because this is the same selection being re-pointed at the
    // same shop — and a bulk verb is itself a re-flow, so a selection dropped
    // here would empty itself the moment you used it, which reads as the second
    // press doing nothing.
    this.setFixtureRef(
      fixtures.find((f) => f.x === at.x && f.z === at.z && f.kind === at.kind)
      ?? fixtures.find((f) => f.id === at.id)
      ?? null,
      { keepPicked: true },
    );
  }

  /**
   * Watch a hire work, or take the camera back with `null`.
   *
   * The flag lives here and the camera lives in the scene, for the same reason
   * `setFixtureRef` is a pair: the menu has to be able to say Unfollow, and two
   * ideas of who is being followed would let a button disagree with the view.
   *
   * It is deliberately NOT saved and not sent. Where somebody's camera is
   * pointing is not part of the shop, and the other player watching their
   * stocker is not something your screen should know about.
   */
  setFollow(id = null) {
    if (this.follow === id) return;
    this.follow = id;
    this.scene?.watch(id);
    // Say so where it was pressed. `panelTick` catches the case where the menu
    // open is somebody else's — the verb is theirs, and only theirs is lit.
    if (this.openPanel === 'worker' && this.workerRef) showWorker(this, this.workerRef);
  }

  /**
   * The fixture under the pointer, from the renderer. Only the hint changes —
   * the gold ring in the world is the renderer's job.
   */
  setAim(f) {
    if ((f?.id ?? null) === (this.aimed?.id ?? null)) return;
    this.aimed = f;
    if (this.buildOn) this.renderBuildHint();
  }

  /**
   * "Bakery Case", "Freezer", "Blender" — what to call this fixture out loud.
   *
   * The catalog's answer, not the kind's, and the same one the server's log
   * lines use — see `fixtureLabel`. It reads the piece now, so a second shelf
   * design is named as itself in the panel heading the way it is drawn as
   * itself in the world.
   */
  fixtureName(f) {
    return fixtureLabel(this.catalog?.fixtures ?? [], f);
  }

  /**
   * The entries on the bar right now — one tab's worth.
   *
   * Not capped at nine any more. The tab is the cap: nine is how many number
   * keys there are, and the tenth entry of a tab is still one tap away rather
   * than behind a second palette. `selectBuildToolByIndex` is the number keys'
   * half of this and stays inside the nine it can name.
   */
  hotbarTools() {
    const browse = this.browseGroups();
    if (browse) return groupAt(browse, this.barTab[this.bar])?.items ?? [];
    return this.openBuildGroup().items;
  }

  /**
   * The tabs of whichever browse bar is up, or null when the one up is the
   * palette. One place that answers it, because the number keys, the Tab key
   * and the bar itself all have to agree about what is on screen — and they
   * did not: two of them asked different fields, and one asked the palette.
   */
  browseGroups() {
    if (this.bar === 'staff') return staffGroups(this);
    return null;
  }

  /**
   * How many of the priced things on the bar this much money reaches.
   *
   * A signature for "which tiles are greyed out", not a readout — the point is
   * that it does NOT move when cash does. Prices are fixed, so a count of the
   * ones at or under your cash is monotone and steps exactly at each price: two
   * different balances that afford the same set answer the same number, and the
   * bar is rebuilt when the set changes rather than when a shopper pays.
   *
   * Which prices depends on which bar is up, because they are two catalogues —
   * asking the palette's costs while the roster is on screen is a signature that
   * never moves for the thing it is watching.
   */
  affordStep(cash) {
    const prices = this.bar === 'staff'
      ? (this.catalog.workers ?? []).map((w) => w.cost)
      : Object.values(this.buildCosts ?? {});
    return prices.filter((c) => c != null && c <= cash).length;
  }

  /**
   * What a number key presses: the nth entry of whichever bar is up, and the
   * same thing tapping it would do. Capped at what the bar draws a number on,
   * so a key can never reach a button that isn't wearing it.
   */
  selectBuildToolByIndex(i) {
    const t = i < KEYED ? this.hotbarTools()[i] : null;
    if (!t) return;
    // The key reaches the same tile the pointer does, so it has to be refused for
    // the same reason — a greyed tile the 6 key still arms is a button that means
    // two different things depending on how you pressed it.
    if (t.poor) return;
    // A browse bar opens a menu rather than arming anything, so a number key
    // does exactly what tapping the entry does — see `renderBrowseBar`. It has
    // to be the same branch, or `selectBuildTool` is handed a person's id.
    if (this.browseGroups()) { this.openBarEntry(t); return; }
    this.commitBuildMode();
    this.selectBuildTool(t.id);
  }

  // ---- sections ------------------------------------------------------------
  //
  // One renderer for every list in the game. Sections describe rows and never
  // touch the DOM, which is what makes search and the chips work in all of them
  // at once — including in sections nobody has written yet.

  /** The rail's own click: open it, or shut it if it's already the one open. */
  toggleSection(id) {
    if (this.openPanel === id) this.closePanel();
    else this.showSection(id);
  }

  /**
   * @param {string} id which section
   * @param {{keep?: boolean}} [opts] `keep` comes BACK to a list rather than
   *   opening one — the item menu's Back press, which is one press deeper into
   *   the supplier rather than somewhere else. Without it the clean slate below
   *   fires and the return trip costs you the tab you were on, the aisle you had
   *   narrowed to, what you had typed, and — worst of the four — the frozen
   *   order, so the row you pressed has moved by the time you are looking at the
   *   list again. That is exactly the "list you work down" this panel's freeze
   *   exists to protect, and a drill-down is the middle of working down one.
   */
  showSection(id, { keep = false } = {}) {
    const sec = sectionById(id);
    if (!sec) return;
    // Coming from a different menu means a clean slate. Coming back to the same
    // one — a live content update, a price change — keeps what you typed.
    // Arriving from somewhere else is a clean slate, and a clean slate is what
    // earns the caret — see `showFilter`.
    if (this.openPanel !== id && !keep) {
      this.releaseMenuMode(); this.clearFilter(); this.resetTab();
      // The aisle goes with the query, and for its reason: it is a narrowing,
      // and a list showing four of forty rows because of something you chose in
      // another menu is a menu that looks broken.
      this.dept = null;
      // ...and the list is taken as it stands. Opening a panel is exactly when
      // you want it sorted by what matters now; every paint after that is when
      // you want it to stop moving. See `freezeOrder`.
      this.thawOrder();
      this._filterFresh = true;
    }
    this.openPanel = id;
    this.setFixtureRef(null);
    this.setWorkerRef(null);
    this.wayRef = null;
    this.panelTick = null;
    // A press waiting on a repaint that will never come, because the menu it
    // was made in is gone.
    this._panelPressed = false;
    sec.onOpen?.(this);
    this._sectionKey = sec.live?.(this) ?? null;
    this.el.search.placeholder = `search ${sec.name.toLowerCase()}…`;
    this.rail.setOpen(id);
    this.paintSection();
    this.renderHotbar();
  }

  /**
   * WHICH TAB IS SHOWING — BY NAME, NEVER BY POSITION.
   *
   * A bucket with nothing in it is never drawn (`grouped`), so a section's tabs
   * are not a fixed row: which slot a tab sits in is a fact about the rest of
   * the shop. The supplier is where that bites. Order one thing and On-the-way
   * comes into existence *above* whatever you were browsing, so an index that
   * meant Rest a tick ago now means the one item you just bought — the whole
   * catalogue gone, out of a press whose entire job was to buy one loaf. It
   * reads as the panel having died rather than as a tab change, because nothing
   * moved on screen except the list, and the way back is an icon you have no
   * reason to think you left.
   *
   * So the tab you are on is remembered as its LABEL and re-found on every
   * repaint. Falling back to the old index is what happens when the tab you
   * were on has genuinely gone — Short emptying because you just fixed it —
   * where its slot is the closest thing to where you were standing.
   *
   * Assigning `ui.tab` is still how anything else picks a tab (`vanLead` jumps
   * to the van list). The setter drops the remembered name for exactly that
   * reason: an index handed in from outside means *this* position, right now,
   * and is pinned to whatever it landed on here.
   */
  tabIndex(groups) {
    const named = groups.findIndex((g) => g.label === this._tabName);
    const want = Math.min(Math.max(0, this._tab ?? 0), groups.length - 1);
    // Where a menu with nothing remembered opens: the first tab, unless that
    // tab is one you can only read. On a quiet morning nothing is Short, so the
    // supplier's first bucket is the van — and it opened onto the one thing you
    // had just ordered with the catalogue nowhere on screen. A press names a
    // passive tab perfectly well; it simply is not what a panel starts on.
    // ...and never onto an EMPTY one, which only became reachable once every
    // bucket started drawing its tab. A menu that opens on "Short: 0" has
    // answered a question nobody asked and hidden the list you came for.
    const usable = (g) => !g.passive && g.count !== 0;
    const first = groups.findIndex(usable);
    const at = named >= 0 ? named
      : (this._tabPick || first < 0 || usable(groups[want])) ? want : first;
    this._tab = at;
    this._tabName = groups[at].label;
    return at;
  }

  /**
   * Hold a list still while you work down it.
   *
   * The supplier sorts on what is due, what is hot and what you hold — all live
   * numbers — so the list re-ordered itself on every repaint and the row you
   * were reaching for slid because a shopper bought something. A panel you *use*
   * has to stay where you left it; a panel you *read* does not, which is why
   * this is opt-in per section rather than a rule about lists.
   *
   * POSITION only, and that is the whole design. The rows themselves are rebuilt
   * every paint, so every number on them is live — what is pinned is the order
   * they come in. Which tab a row lands in is live too: a shelf that runs dry
   * while you are reading still appears under Short, in the place its item has
   * always had.
   *
   * A row nobody has seen before goes to the END rather than into its sorted
   * place, keeping the order it arrived in. Authoring an item over MCP while the
   * panel is open should not reshuffle what is in front of you — and "new things
   * are at the bottom" is a rule you can act on, where "new things are wherever
   * the sort put them" is the churn this exists to stop.
   */
  freezeOrder(key, rows, idOf) {
    const seq = this._frozen?.[key];
    if (!seq) {
      (this._frozen ??= {})[key] = new Map(rows.map((r, i) => [idOf(r), i]));
      return rows;
    }
    const end = seq.size;
    let extra = 0;
    const at = new Map(rows.map((r) => {
      const id = idOf(r);
      // Recorded as it is handed out, so two new rows keep their own order and
      // do not swap places on the next paint.
      if (!seq.has(id)) seq.set(id, end + extra++);
      return [r, seq.get(id)];
    }));
    return [...rows].sort((a, b) => at.get(a) - at.get(b));
  }

  /**
   * ...and which BUCKET a row is in, held still the same way.
   *
   * Position alone was half a freeze, and the missing half is the one that made
   * the panel unusable: `grouped` puts a row in the first bucket that takes it,
   * and every one of those tests reads a number your own press just moved. Buy
   * six loaves and Bread is `inbound > 0`, so it leaves Short for the van tab —
   * out of the list you were working down, on the tick you worked it. Nudge a
   * minimum and the row crosses the other way. Either one reads as the row
   * having been eaten by the press, because the thing you were aiming at is the
   * thing that vanished; you cannot check what you just did, and you cannot do
   * two things to one item without going to find it again.
   *
   * So a row keeps the tab it was in when the list was taken, until you ask for
   * a new list. That is the same bargain `freezeOrder` makes and it costs the
   * same thing: a shelf that runs dry while you read stays under Rest until the
   * refresh button, which is the one control this rests on — see the caveat on
   * `thawOrder`. The counts on the headings are counts of the frozen bins for
   * the same reason, or the tab would say 4 over a list of three.
   *
   * A row nobody has seen before is filed where it belongs *now*, exactly as a
   * new row is appended rather than sorted: there is no remembered place to
   * keep, and the first paint of every row goes through here.
   */
  freezeBin(key, id, live) {
    const seq = ((this._frozen ??= {})[key] ??= new Map());
    if (!seq.has(id)) seq.set(id, live);
    return seq.get(id);
  }

  /**
   * Take the list as it stands now — the refresh button, and opening a panel.
   *
   * Clearing everything rather than one key is deliberate now that a section
   * freezes two things: a list whose rows had been re-sorted into tabs they are
   * no longer in is a worse list than either freeze on its own.
   */
  thawOrder(key = null) {
    if (!this._frozen) return;
    if (key) delete this._frozen[key];
    else this._frozen = {};
  }

  /** No choice made: the next paint decides, and may skip a passive tab. */
  resetTab() { this._tab = 0; this._tabName = null; this._tabPick = false; }

  get tab() { return this._tab ?? 0; }

  /** A tab asked for by position — a press, or `vanLead` jumping to the van. */
  set tab(n) { this._tab = n; this._tabName = null; this._tabPick = true; }

  paintSection() {
    const sec = sectionById(this.openPanel);
    if (!sec) return;
    const all = sec.rows(this);
    // Search over four rows is noise, so the controls only appear once a list
    // is long enough to get lost in — and can't leave a filter behind when it
    // shrinks back under the line.
    // A section only gets the controls if it declared what its rows can be
    // filtered *by*. A readout like the shop report has nothing to search.
    const listable = all.filter((r) => !r.sep);
    const filterable = !!sec.facet && listable.length >= 8;
    if (!filterable && this.query) this.clearFilter();

    // Searching is a question about the whole menu, not about the tab you happen
    // to be on, so an active query collapses the tabs and searches everything.
    const groups = filterable && this.query ? null : tabGroups(all);

    let rows;
    let tabs = '';
    // Hoisted out of the branch because the scroll key below needs it: which
    // tab you are on is part of what is on screen, not just part of drawing it.
    let at = 0;
    if (groups) {
      at = this.tabIndex(groups);
      // How many are in each, on the tab. It answers the question the tab is
      // for without costing a press — "is anything to do" is the supplier's
      // whole first tab — and it is what makes an always-drawn empty tab
      // readable as empty rather than as broken. Only where a section counted
      // (`grouped`); a menu whose headings are just headings gets no badges.
      //
      // A `quiet` bucket keeps its count off the tab entirely: a badge is a
      // count of work, and a browse tab counting the catalogue would be claiming
      // to be the biggest job on the strip. Still dimmed when empty, which is a
      // fact about the tab rather than a number on it.
      //
      // The label is WRITTEN rather than hovered. A section's tabs are short
      // nouns — To do, Buy, Made here — and a strip of four glyphs is a strip
      // you have to point at one at a time to read, on a menu whose whole job is
      // to be scanned. That also retires the `title`: a tooltip repeating text
      // that is already on the button is a second copy of the answer that only
      // one kind of pointer can ask for, and no touchscreen has it. Fixture
      // menus keep their icon-only strip on purpose — those headings are
      // sentences ("Keep it for"), which is a caption rather than a tab.
      tabs = `<div class="tabs">${groups.map((g, n) => `
        <button class="tab named${n === at ? ' on' : ''}${g.count === 0 ? ' none' : ''}" data-tab="${n}">${
  g.icon}<span class="tlabel">${esc(g.label)}</span>${
  g.count != null && !g.quiet ? `<i class="tcount">${g.count}</i>` : ''}</button>`).join('')}</div>`;
      rows = [...groups.lead, ...groups[at].rows];
    } else {
      rows = filterable ? this.applyFilter(all) : all;
    }

    // ...and under the tabs, the aisle — for any section whose rows carry one
    // (`client/aisles.js`). The supplier is the case: every item in the shop, in
    // one list, where the question you arrived with is "show me produce" and a
    // search box can only answer "show me the thing I can already name".
    //
    // Drawn off what the open TAB holds, so the chips are the aisles in front of
    // you rather than the aisles in the menu. It is skipped entirely while a
    // search is running, for the reason the tabs are: a query is a question
    // about the whole menu, and two narrowings on screen at once is an empty
    // pane with two possible explanations.
    let aisles = '';
    if (!(filterable && this.query)) {
      const depts = deptsIn(rows);
      const dept = depts.includes(this.dept) ? this.dept : null;
      if (depts.length > 1) aisles = deptStrip(depts, dept);
      rows = inDept(rows, dept);
    }

    // ...and under those, the column heads, for the one list in the game that
    // stopped being a list of sentences and became a table. Four numbers across
    // a supplier row — what it costs, how many you hold, a minimum, a maximum —
    // and nothing anywhere saying which was which: `MIN` and `MAX` label
    // themselves inside their own steppers, and the other three are bare
    // figures you have to already know the shape of.
    //
    // Declared per SECTION and asked of the rows about to be drawn, because a
    // head over rows that have no such columns is a caption that lies: the
    // supplier's Automatic tab is three switches, and "Cost · Have · Order"
    // over them names nothing on screen. A section that says nothing gets what
    // it always got.
    const heads = sec.heads?.(rows) ?? null;
    // A head names its column by the SELECTOR that finds it on a row, so the
    // widths can be measured rather than restated (below). The one head with no
    // selector is the elastic column — the name — which takes what is left the
    // way `.row .name` does, and must not be measured or it would be pinned to
    // whatever the first row happened to need.
    const headBar = heads ? `<div class="heads">${heads.map((h) => `
      <span class="hcell${h.sel ? '' : ' grow'}${h.at ? ` ${h.at}` : ''}"${
  h.sel ? ` data-head="${esc(h.sel)}"` : ''}>${esc(h.label)}</span>`).join('')}</div>` : '';

    // "Nothing matches that" is the answer to a SEARCH, and an empty tab is now
    // something you can press your way onto with no search running at all —
    // where it reads as the filter having eaten the list. An empty bucket is
    // good news in most of them (nothing is short), so it says which.
    const body = rows.length
      ? rows.map((r, i) => this.rowHtml(r, i, !!heads)).join('')
      : `<div class="foot">${this.query ? 'Nothing matches that.'
        : esc(groups?.[at]?.empty
          ?? `Nothing ${(groups?.[at]?.label ?? '').toLowerCase() || 'here'} right now.`)}</div>`;

    // Which section, which tab of it, and what it is filtered to. All three
    // change what the list IS, so all three have to drop your place — a search
    // that kept its offset would leave you scrolled past three results.
    // A section may hang a readout off the right of its own title — see
    // `vanNote`. Part of the title rather than a third argument, because
    // `showPanel` already takes the title as HTML for the fixture menu's icon.
    this.showPanel(sec.title + (sec.note?.(this) ?? ''),
      tabs + aisles + headBar + body + (sec.foot ? `<div class="foot">${sec.foot(this)}</div>` : ''),
      `section:${this.openPanel}:${tabs ? at : ''}:${this.query}:${this.dept ?? ''}`);
    this.showFilter(filterable);
    this.steadyHeight(sec, groups);
    this.wireRows(rows);
    this.el.panelBody.querySelectorAll('[data-tab]').forEach((el) => {
      el.onclick = () => { this.tab = Number(el.dataset.tab); this.paintSection(); };
    });
    // The aisle is kept ACROSS tabs on purpose — the supplier's To do and Buy
    // are the same catalogue asked two ways, and hunting produce through both is
    // one errand. A tab that has no rows in it falls back to All on its own,
    // since `deptsIn` is asked of what is actually in front of you.
    this.el.panelBody.querySelectorAll('[data-dept]').forEach((el) => {
      el.onclick = () => { this.dept = el.dataset.dept || null; this.paintSection(); };
    });
    // One row, and it scrolls — see `wireDepts`. Every press above repaints this
    // whole menu, so the strip is a new element each time and has to be told
    // again where it is scrolled to.
    wireDepts(this.el.panelBody);
    // ...and it stays put while the list scrolls, like the tabs above it: both
    // are choosers, and one that scrolled away would leave you in a narrowed
    // list with no way back to the whole one. A section scrolls the body, so
    // this is `sticky` under a `sticky` — and where the second one sticks is
    // MEASURED off where the first one ends rather than written down, because
    // the tab strip's height is padding, a glyph and a border, three numbers
    // that are the stylesheet's business and not this file's.
    const tabBar = this.el.panelBody.querySelector('.tabs');
    // `.dwrap` and not `.dtabs` — the bar is the wrapper, and the strip inside
    // it is the part that scrolls and fades. See `deptStrip`.
    const aisleBar = this.el.panelBody.querySelector('.dwrap');
    if (tabBar && aisleBar) aisleBar.style.top = `${aisleBar.offsetTop - tabBar.offsetTop}px`;
    // The heads are the third sticky bar in the stack and stick the same way,
    // off whichever of the three is first — a head strip that scrolled away
    // would leave you looking at four columns of numbers with nothing naming
    // them, which is the state this exists to end.
    const headEl = this.el.panelBody.querySelector('.heads');
    if (headEl) {
      const first = tabBar ?? aisleBar ?? headEl;
      headEl.style.top = `${headEl.offsetTop - first.offsetTop}px`;
      // ...and each head is as wide as the column it names, MEASURED off a cell
      // that is on screen rather than written down here — the same call the
      // aisle strip's `top` makes above. Every one of those widths is a padding,
      // a glyph and a font in the stylesheet, and a copy of the arithmetic in
      // this file would be a head that is right until somebody restyles a
      // stepper. The name column is the elastic one and takes what is left,
      // exactly as the rows do.
      //
      // The first cell of that column ANYWHERE in the list rather than the
      // first row's, because a filtered list can open with a row that has no
      // such column — the supplier's three settings rows match a search like
      // anything else — and a head measured off one would be a head measured
      // off nothing. The columns agree with each other because `.cols` holds
      // them open to a width every row meets.
      headEl.querySelectorAll('[data-head]').forEach((el) => {
        const cell = this.el.panelBody.querySelector(el.dataset.head.split(',')
          .map((s) => `.sec-row ${s.trim()}`).join(','));
        if (cell) el.style.width = `${cell.offsetWidth}px`;
      });
    }
    // The one control that lives in the title bar. Wired here rather than in
    // `showPanel` because the note is a section's own HTML — and `stopPropagation`
    // because that strip is the drag handle, so a press on it would otherwise
    // start moving the window as well as sorting the list.
    this.el.panelTitle.querySelector('[data-resort]')?.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.thawOrder();
      this.paintSection();
    });
  }

  /**
   * HOLD THE PANEL AT THE HEIGHT OF ITS TALLEST TAB.
   *
   * A tab strip is a promise that the tabs are alternatives, and a window that
   * resizes as you press along it breaks that promise twice: the thing you are
   * comparing moves, and the tab you want next is no longer under the cursor —
   * on a panel anchored at the bottom, growing upward, the strip itself is what
   * moves furthest. Seven fixture upgrades against two for you is a panel that
   * doubles in height on one press.
   *
   * OPT-IN, per section (`steady`), and the Menu is the argument for that: its
   * Controls tab is thirty rows of keys, so a rule that applied everywhere would
   * hold the sound switches at the height of the keyboard reference. It is
   * worth it where the tabs are the same *kind* of thing at different lengths,
   * and wrong where one tab is a reference list.
   *
   * The pitch is MEASURED off two rows that are on screen rather than written
   * down as a row height — the CSS owns that number, it changed twice this week
   * (the 3px gap, the centred lead), and a copy of it here would be a panel
   * that is right until somebody restyles a row. Falls back to one row's own
   * height for a tab holding exactly one, and does nothing at all with none:
   * a `min-height` guessed from no evidence is worse than a panel that jumps.
   *
   * It can exceed what the screen has, and that is fine — `#panel` caps itself
   * and the body scrolls, which is the same answer a long tab already gets.
   */
  steadyHeight(sec, groups) {
    const body = this.el.panelBody;
    if (!sec.steady || !groups) { body.style.minHeight = ''; return; }
    const drawn = body.querySelectorAll('.sec-row');
    const pitch = drawn.length >= 2
      ? drawn[1].offsetTop - drawn[0].offsetTop
      : (drawn[0]?.offsetHeight ?? 0);
    if (!pitch) { body.style.minHeight = ''; return; }
    // Every tab shows the lead rows too, so they are part of every tab's height
    // rather than of the tallest one's.
    const most = Math.max(...groups.map((g) => g.rows.length)) + groups.lead.length;
    /**
     * ...and never taller than the panel can show, which is the half this was
     * missing.
     *
     * `#panel-body` scrolls because it overflows, and a `min-height` set to the
     * tallest tab's WHOLE content means it never does: the body simply grows to
     * that height, the panel clips it, and what you get is a list you can see is
     * cut off and cannot move. Upgrades is where it bites, because it is the
     * longest tab in the game.
     *
     * It takes the fade down with it, too. The mask is measured on the box it
     * is applied to, so a body four hundred pixels taller than the panel fades
     * twenty pixels of a box you can only see half of — which lands on screen as
     * rows ghosted most of the way down the list rather than a hairline at the
     * edge.
     *
     * The cap comes off the panel's own computed `max-height` rather than off
     * its current height: cleared, the panel is only as tall as this tab's
     * content, so measuring it here would cap a short tab at its own size and
     * this would do nothing at all.
     */
    const cap = parseFloat(getComputedStyle(this.el.panel).maxHeight);
    const room = Number.isFinite(cap) ? Math.max(0, cap - body.offsetTop - 8) : Infinity;
    body.style.minHeight = `${Math.round(Math.min(pitch * most, room))}px`;
  }

  /**
   * Redraw whatever is open, whichever kind of menu that is.
   *
   * The search box is ONE element that outlives every panel — it has to be, or
   * typing into it would rebuild the input it is typing into and take the caret
   * with it — so it cannot be wired to a particular menu's repaint. It asks
   * here instead. A fixture menu is the only other filterable one today; a
   * section is the default because `paintSection` no-ops on anything that isn't.
   */
  repaint() {
    if (this.openPanel === 'fixture') {
      if (this.fixtureRef) showFixture(this, this.fixtureRef);
      return;
    }
    this.paintSection();
  }

  /**
   * Search covers the tags as well as the name, which is what let the chip row
   * go: it listed the whole vocabulary of whatever was on screen — thirty-odd
   * chips above eighteen items in the supplier — to do a job that typing
   * "organic" already does, in a fraction of a panel that is only 214px wide.
   */
  applyFilter(rows) {
    const q = this.query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      // A heading with everything under it filtered away is a heading over
      // nothing, so headings only survive an unfiltered list. A drawn block is
      // the same case: it has no name to match and is not a result — and so is
      // a block of switches, which has several names and is not one of them.
      if (r.sep || r.html != null || r.grid) return false;
      return `${r.name} ${r.sub ?? ''} ${(r.facets ?? []).join(' ')}`.toLowerCase().includes(q);
    });
  }

  clearFilter() {
    this.query = '';
    this.el.search.value = '';
  }

  /**
   * The search box, up or down — and the caret in it the first time it goes up.
   *
   * Every menu that filters calls this instead of touching `filter.hidden`,
   * because the box being visible is not the same question as whether you have
   * just arrived at it. `showPanel` hides it on every repaint and the caller
   * puts it straight back, so a plain "it became visible, focus it" would fire
   * on every keystroke you typed into it and on every 10Hz redraw behind it —
   * and the redraws are the bad half: focus would be dragged back off whatever
   * you clicked next, and the next W would type a W instead of walking.
   *
   * `_filterFresh` is therefore set at the two places you can *arrive* at a
   * menu (`showSection` from another one, `showFixture` on another unit) and
   * spent the first time a box actually appears — which also covers a menu that
   * opened on a short tab and grew a search box when you changed tabs.
   *
   * Not on a touch screen: there the caret is a keyboard over the bottom half
   * of the panel you just opened, which nobody asked for by tapping a shelf.
   */
  showFilter(on) {
    this.el.filter.hidden = !on;
    if (!on || !this._filterFresh) return;
    this._filterFresh = false;
    if (matchMedia('(pointer: coarse)').matches) return;
    // `preventScroll` because focus otherwise scrolls the box into view, and
    // the box is inside a panel that has its own remembered scroll offset.
    this.el.search.focus({ preventScroll: true });
  }

  /**
   * One row.
   *
   * The icon and what the thing costs share one narrow column down the left,
   * because a price sitting out on the right reserves a whole column of width
   * for four characters and pushes every name into a second line. A plain
   * readout keeps its value on the right — there is no icon to stack it under
   * and the labels want to line up.
   *
   * The description wraps and is clamped to two lines, so a row stays bounded
   * whatever the copy says. It carries NO `title`: it used to repeat itself into
   * one as an escape hatch for the clamp, which meant hovering a row put a tip
   * over the panel saying word for word what was already printed under the
   * pointer — and the tip is opaque, so the answer covered the rows either side
   * of the question. Two lines of 10.5px is about 90 characters and every sub in
   * the game fits; a longer one should be shortened rather than hidden behind a
   * hover nobody would know to try.
   *
   * `mark` is that shortening, taken to its end: a **state** the row is in, as
   * one glyph with the sentence in its `title`. It is not the same trick the
   * paragraph above bans — that one repeated the visible text into a tip, so
   * the hover was pure cost; this one is the only place the words exist, and
   * the glyph is what fits. Three states earned it, and what they have in
   * common is that they are the same words on every row that has them and none
   * of them is a number you scan for: your crew stopped stocking this, it is on
   * a shelf already, it is made in an appliance. Printed in full they crowded
   * out the caption AND ellipsised anyway — a 214px panel clamped
   * "your crew stopped stocking this — bac…", which is a sentence that stops
   * exactly before the part with the information in it.
   *
   * A row that gives its caption up to a mark falls back to printing its tags,
   * so the line is spent on something the glyph does not already say.
   *
   * `art` wins over `icon` where a row has one — a picture of the thing beats a
   * glyph for its kind, which is the same call the palette makes, and `icon`
   * stays as the fallback for anything nobody has drawn.
   */
  rowHtml(r, i, cols) {
    if (r.sep) return `<div class="sep">${r.sep}</div>`;
    // A menu that draws itself. `sep` was already the precedent — a thing in the
    // rows array that is not a row — and this is the same escape hatch one step
    // further: the Shop report is a picture rather than a list, and wrapping it
    // in `.row` would give it a hover, a click target and a lead column it has
    // no use for. It carries no `name`, so `applyFilter` drops it the way it
    // drops a heading, and no `run`, so `wireRows` never looks at it.
    // A raw block, wrapped only if it has presses in it. `acts` is per ROW and
    // the wiring below finds them by `data-acts`, so an html row without this
    // could author a `data-act` button that silently never fires — which is the
    // dead-press shape, and the panel would look perfectly correct doing it.
    // Wrapping unconditionally would put a div round fourteen menus that do not
    // need one, so it is asked the same way the ordinary row asks it.
    if (r.html != null) return r.acts ? `<div data-acts="${i}">${r.html}</div>` : r.html;
    /**
     * SEVERAL SWITCHES AS ONE BLOCK.
     *
     * A row is a sentence — a name, a caption, a state on the right — and that
     * shape is worth its height for anything you have to read. It is pure cost
     * for a switch you already know the name of: four of them down the Menu's
     * Game tab spent four full-width rows and two headings saying "on" four
     * times, which is the menu describing itself.
     *
     * So a `grid` row is a row that holds several presses, each a tile with a
     * glyph, a word and its state. It goes through `data-acts` — the same
     * plumbing a stepper uses — so `wireRows` needs to know nothing about it,
     * and a tile may hang a second small press off its corner (`extra`) for the
     * rare verb that would otherwise cost a row of its own.
     *
     * The caption is a `title` rather than a line, which is the `mark` argument
     * made about a whole row: these are the only words that say what the switch
     * does, and a tile is not wide enough to print them.
     */
    /**
     * A ROW THAT IS A BUTTON.
     *
     * Its own markup rather than a class on `.row`, and the reason is the one
     * thing centring a row cannot do. A row is `[icon][name][…]` in a line, and
     * `.name` is the elastic column the whole panel is built around — so it is
     * as wide as its widest line, which is the caption. Centre the row and what
     * you get is the glyph pinned to the left of a column the width of the
     * caption, with the label centred somewhere off in the middle of it: the
     * two halves of one label a hundred pixels apart, and the label not over the
     * middle of the panel either, because the glyph is outside the stack it is
     * meant to belong to. It looks like a mistake because it is one.
     *
     * So the glyph goes INSIDE, on the label's own line, and the caption sits
     * under both — which is a button, and is what this row always was. `data-row`
     * on the button itself, so `wireRows` needs no more than it already has.
     */
    if (r.mid) {
      return `<button class="midrow" data-row="${i}">
        <span class="midtop">${r.icon ?? ''}<b>${r.name}</b></span>
        ${r.sub ? `<span class="midsub">${r.sub}</span>` : ''}
      </button>`;
    }
    if (r.grid) {
      return `<div class="grid" data-acts="${i}">${r.grid.map((t) => `
        <div class="gcell">
          <button class="gtile${t.on ? ' on' : ''}" data-act="${t.id}"
            title="${esc(t.title ?? t.name)}" aria-pressed="${t.on ? 'true' : 'false'}">
            <span class="gico">${t.icon}</span>
            <span class="gname">${t.name}</span>
            <span class="gstate">${t.on ? 'On' : 'Off'}</span>
          </button>
          ${t.extra ?? ''}
        </div>`).join('')}</div>`;
    }
    const cls = ['row', 'sec-row'];
    if (r.picked) cls.push('picked');
    if (r.dim) cls.push('owned');
    // Two weights of "not the obvious choice", because one weight was being
    // asked to say two things. `dim` is CANNOT — no board free, no appliance to
    // make it — and it is half-faded next to a row with nothing to press. `soft`
    // is CAN, BUT: something else in the shop already has this, and ticking is
    // exactly how you overrule that. At the same fade the two were one picture,
    // so a choice you were being offered read as one that had been taken away.
    if (r.soft) cls.push('muted');
    if (r.run) cls.push('clickable');
    const stacked = !r.plain;
    return `<div class="${cls.join(' ')}"${r.run ? ` data-row="${i}"` : ''}${
  r.acts ? ` data-acts="${i}"` : ''}>
      ${stacked && (r.art || r.icon || r.right) ? `<div class="lead">
        ${r.art ? `<span class="bico art">${r.art}</span>`
    : r.icon ? `<span class="bico">${r.icon}</span>` : ''}
        ${r.right ? `<span class="cost">${r.right}</span>` : ''}
      </div>` : ''}
      <div class="name"><span class="t">${r.name}</span>${
  r.heat || r.sub || r.mark ? `<span class="meta">${r.heat ?? ''}${
    // Before the caption, because it is the stronger fact — a line the shop has
    // stopped stocking is not a row you go on reading the tags of. `title` is
    // the whole sentence and is escaped: it is the one attribute in this row
    // built from copy rather than from a number.
    r.mark ? `<span class="mark${r.mark.warn ? ' warn' : ''}" title="${esc(r.mark.title)}">${r.mark.icon}</span>` : ''}${
    r.sub ? `<span class="tags${r.subWarn ? ' warn' : ''}">${r.sub}</span>` : ''}</span>` : ''}${
  // How far along something is, 0..1. Inside the name's column rather than
  // beside it, because that column is the only elastic thing in the row — a bar
  // in the row itself would compete with the name for width and lose, and a
  // 30px bar says nothing a number does not say better.
  r.bar != null ? `<span class="rbar"><i style="width:${Math.round(Math.max(0, Math.min(1, r.bar)) * 100)}%"></i></span>` : ''}</div>
      ${!stacked && r.right ? `<div class="price">${r.right}</div>` : ''}
      ${r.count ? `<span class="held ${r.countClass ?? ''}">${r.count}</span>` : ''}
      ${r.rule ?? (cols ? '<span class="rule"></span>' : '')}
      ${r.button ? `<button data-btn="${i}"${
    // What the press IS, for anything outside this file that has to NAME it —
    // the tutorial's pulse, today. `data-btn` cannot: it is an index into a
    // list that re-sorts, and one row's slot is another row's slot the moment
    // a van arrives. Same argument, and the same shape, as `data-entry` on a
    // bar tile. Optional, because most rows have one button and nothing has
    // ever needed to point at it.
    r.button.tag ? ` data-btn-tag="${r.button.tag}"` : ''}${r.button.danger ? ' class="danger"' : ''}>${r.button.label}</button>`
    // An empty cell under a head, for the rows that have nothing in that
    // column — a made-here item has no standing order and no buy button, and
    // dropping the cells rather than emptying them slides its count and its
    // name out from under the words naming them. A column is only a column if
    // every row has one.
    : cols ? '<span class="bpad"></span>' : ''}
      ${r.tail ? `<span class="have">${r.tail}</span>` : ''}
    </div>`;
  }

  wireRows(rows) {
    this.el.panelBody.querySelectorAll('[data-row]').forEach((el) => {
      el.onclick = () => rows[Number(el.dataset.row)]?.run?.(this);
    });
    // Any number of small presses inside one row, each naming itself with the
    // same `data-act` a fixture verb uses — so a strip of squares and a row of
    // steppers wire identically and neither knows which menu it landed in.
    // `stopPropagation` because the row may itself be a button: nudging a
    // minimum is not also a request to open the thing you nudged it on.
    this.el.panelBody.querySelectorAll('[data-acts]').forEach((el) => {
      const row = rows[Number(el.dataset.acts)];
      el.querySelectorAll('[data-act]').forEach((b) => {
        b.onclick = (e) => { e.stopPropagation(); row?.acts?.[b.dataset.act]?.(this); };
      });
    });
    this.el.panelBody.querySelectorAll('[data-btn]').forEach((el) => {
      el.onclick = (e) => {
        // The whole row may be a button too — buying six apples is not also a
        // request to close the supplier.
        e.stopPropagation();
        rows[Number(el.dataset.btn)]?.button?.run(this);
      };
    });
  }

  /** Item lookups, used by every menu that names one. */
  itemById(id) { return this.catalog.items.find((i) => i.id === id) ?? null; }

  /**
   * How many of a thing are standing on the shop's shelves right now.
   *
   * Up here rather than in whichever panel wanted it first, because two menus
   * now print "how many have I got" and two spellings of that is how the
   * supplier ends up disagreeing with the shelf you are stood at. The supplier
   * asks this one on its own — "running low" is a fact about a *board*, and a
   * crate in the yard has not filled anything.
   */
  heldOf(itemId) {
    let n = 0;
    for (const s of this.state?.shelves ?? []) {
      for (const k of s.stacks ?? []) if (k.item_id === itemId) n += k.qty ?? 0;
    }
    return n;
  }

  /**
   * ...and how many are in the shop but NOT on a board.
   *
   * Crates on the floor and armfuls in hands — goods you have already paid for
   * that are not earning anything where they are. Its own function rather than
   * folded into `heldOf` because the two answer opposite questions: `heldOf`
   * says whether a shelf needs filling, and this says whether there is anything
   * to fill it WITH, which is the one that decides what a board should be
   * kept for.
   */
  /**
   * Whoever you are, out of the latest snapshot.
   *
   * `main.js` needs it to ask "am I stood at that crate", which decides which
   * message a press sends. One spelling of "which of these players is me", so a
   * second copy cannot go looking in a stale `state`.
   */
  me() {
    return (this.state?.players ?? []).find((p) => p.id === this.net.myId) ?? null;
  }

  /**
   * Every side of a fixture somebody can work it from — the client's half of
   * `Game.fixtureSpots`.
   *
   * Both ends call the same `spotsOf` with the same two inputs, which is the
   * only reason a marker and a reach test can agree: this decides what lights
   * up and the sim decides what happens, and a spot drawn here that the shop
   * then refuses you at is the green-ghost bug wearing a different hat.
   *
   * Lives on UI rather than in `main.js` because both things it needs are here
   * — the catalog row that says whether the piece is open all round, and the
   * layout to test each side against.
   */
  spotsFor(f) {
    if (!f) return [];
    return spotsOf(f, {
      layout: this.scene?.storeLayout ?? null,
      open: openOf(this.catalog?.fixtures ?? [], f),
    });
  }

  /**
   * ...and which of those the world should actually PAINT.
   *
   * Only while building. The rings answer a question you have when you are
   * placing something — can people get at this, which side does the queue form
   * on — and shopkeeping never asks it: you walk up to a shelf and use it, and
   * two circles on the floor beside the thing you are already using are a
   * diagram of a decision that was made when it was built. Every marker in this
   * game is a promise that a press does something, and these promise nothing.
   *
   * A separate question from `spotsFor` rather than a flag inside it, because
   * reach still has to know about every side while the rings are hidden — what
   * changed is what is drawn, not what is true.
   */
  markerSpots(f) {
    return this.buildOn ? this.spotsFor(f) : [];
  }

  spareOf(itemId) {
    let n = 0;
    // Every pile in every box and every pair of hands. Asked the old way — is
    // this container's one item the one I want — a mixed crate hides everything
    // but its first pile, and the shelf menu's "you already have N spare" would
    // quietly under-count the shop's own stock.
    for (const d of this.state?.deliveries ?? []) n += lotQty(d, itemId);
    for (const p of this.state?.players ?? []) {
      n += lotQty(p.carry, itemId) + lotQty(p.haul, itemId);
    }
    return n;
  }

  /**
   * How much the world wants this particular item right now.
   *
   * The demand meter says a *tag* is hot, which is only half an answer — you
   * still have to know which of forty items carries it. This folds the same
   * numbers down onto one item, exactly the way `folded()` does server-side:
   * multiply every active modifier whose tag it carries. An item on two hot
   * tags is genuinely twice as wanted, and should say so.
   */
  heatFor(item) {
    let mult = 1;
    for (const m of this.state?.modifiers ?? []) {
      if (item.tags?.includes(m.tag)) mult *= m.demand ?? 1;
    }
    return mult;
  }

  /** That number as a pill, or nothing when the world is indifferent. */
  heatPill(item) {
    const mult = this.heatFor(item);
    if (mult >= 1.25) return `<span class="heat up">▲ ×${mult.toFixed(1)}</span>`;
    if (mult <= 0.8) return `<span class="heat down">▼ ×${mult.toFixed(1)}</span>`;
    return '';
  }
  itemName(id) { return this.itemById(id)?.name ?? id ?? 'something'; }

  /**
   * What to do next, read off the snapshot everything else already reads.
   *
   * Deliberately derived on the client rather than sent by the server: it is a
   * *reading* of the state, not part of it, so it can be reworded or reordered
   * without a protocol change, and a player with the panel open sees the same
   * numbers the panel is showing them.
   *
   * Ordered by what it costs you to ignore, and capped at three. The first
   * entry is the interesting one — a tag the world currently wants that you
   * have nothing of is money walking back out of the door, and it is the one
   * thing here you would never work out by looking at the shop.
   */
  todoList(state) {
    const out = [];
    const shelves = state.shelves ?? [];
    const plots = state.plots ?? [];

    // Above everything, and it has to be: a shop with its shutters down cannot
    // fail to serve a hot tag, cannot run a shelf bare and cannot turn anybody
    // away, so every other chip in here goes quiet at exactly the moment the
    // shop is doing nothing at all. A new world starts shut, so this is the
    // first thing it ever says — and "no customers are coming" is otherwise a
    // silence you have to diagnose.
    //
    // The SHUTTERS, not `isOpen`: reading the latter would put this chip up
    // every single night, nagging about a shop that is shut because it is four
    // in the morning. A to-do you cannot do is noise.
    if (state.shutters === false) {
      // ...and it is the one chip that is also the BUTTON. Every other line in
      // here names something you go and do somewhere else — get a tag in, sow a
      // bed, hire somebody — but opening up is one switch, already reachable
      // from the sign and from a key that a phone does not have. A chip that
      // names the key and cannot be pressed is a to-do you can only read.
      out.push({
        // The key is dropped where there is no keyboard to press it on. It is
        // the same call the rail makes about its own key caps (`.kb`, hidden
        // under the same width) — a shortcut printed at somebody holding a phone
        // is a line of the sentence that cannot be acted on, and this chip is
        // the one that is up at the moment somebody has least idea what to do.
        icon: 'shop', hot: true, text: `The shop is <b>shut</b> — open up${pillDrives() ? '' : ' (O)'}`,
        run: () => this.setOpen(true),
      });
    }

    // Only tags you're actually failing to serve. A hot tag you already have
    // three shelves of isn't news, it's just the day going well.
    const stocked = new Set();
    for (const s of shelves) {
      // Every board — a unit can carry three kinds now, and reading one of them
      // would have the shop nag you to get a tag in that is already on a shelf.
      for (const k of s.stacks ?? []) {
        if (!k.qty) continue;
        for (const tag of this.itemById(k.item_id)?.tags ?? []) stocked.add(tag);
      }
    }
    // Net demand, so a tag two events are fighting over only makes the list if
    // the fight is actually being won — the meter above draws the same number.
    const missed = (state.modifiers ?? [])
      .filter((m) => m.demand >= 1.5 && !stocked.has(m.tag))
      .sort((a, b) => b.demand - a.demand)[0];
    if (missed) {
      // Name something you could actually buy. "Get viral in" is a riddle if
      // you don't already know which of forty items carries the tag — and the
      // whole point of a to-do chip is that you can act on it without going
      // and working something out first. Cheapest match, since the chip is a
      // nudge rather than a strategy.
      const example = this.catalog.items
        .filter((i) => i.tags?.includes(missed.tag))
        .sort((a, b) => a.base_cost - b.base_cost)[0];
      out.push({
        icon: 'supplier', hot: true,
        text: example
          ? `Get <b>${esc(example.name)}</b> in — ${esc(missed.tag)} ×${missed.demand}`
          : `Get <b>${esc(missed.tag)}</b> in — wanted ×${missed.demand}`,
      });
    }

    const ready = plots.filter((p) => p.ready).length;
    if (ready) out.push({ icon: 'plot', text: `<b>${ready}</b> ready to harvest` });

    const bare = shelves.filter((s) => !(s.stacks ?? []).some((k) => k.qty > 0)).length;
    if (bare) out.push({ icon: 'shelf', text: `<b>${bare}</b> ${bare > 1 ? 'shelves' : 'shelf'} empty` });

    const floor = (state.deliveries ?? []).length;
    if (floor) out.push({ icon: 'crate', text: `<b>${floor}</b> to put away` });

    // Turned soil with nothing in it is the farm equivalent of an empty shelf.
    const unsown = plots.filter((p) => p.soil === 'tilled' && !p.crop_id).length;
    if (unsown) out.push({ icon: 'seeds', text: `<b>${unsown}</b> plot${unsown > 1 ? 's' : ''} to sow` });

    return out.slice(0, 3);
  }

  /**
   * Choose the seed a picked bed goes back to.
   *
   * Nothing on screen calls this today, and that is the honest state of it: a
   * bed's own menu names its crop when you sow, and the server treats that as
   * the choice, so the only two callers this ever had were a boot default and
   * an unlabelled number key — neither of which was anybody choosing anything.
   * Kept because it is the client half of `select-crop`, and because a seed
   * picker that is visible is a thing somebody may well want back.
   */
  selectCrop(id) {
    this.selectedCrop = id;
    // The server plants from its own copy, and mirrors it back down in the
    // snapshot. Setting it here too is just so the picker doesn't lag a tick.
    this.net.send('select-crop', { cropId: id });
  }

  /**
   * Raise or drop the shutters. The server decides; this only asks.
   *
   * Working them ONCE, either way, retires the nudge on the sign for good. It
   * is in `localStorage` rather than on the save because what it remembers is
   * about the person and not about the shop — somebody who has opened one shop
   * knows where the button is, and being handed a second world does not unlearn
   * it. Same argument and same store as `whoAmI` in net.js.
   */
  setOpen(open) {
    this.net.send('shop-open', { open: !!open });
    if (!this.shutterUsed) {
      this.shutterUsed = true;
      try { localStorage.setItem(SHUTTER_KEY, '1'); } catch { /* private mode */ }
      this._clockKey = null;   // so the next `setClock` actually redraws it
    }
  }

  /**
   * Stop or start the world. Same shape, same reason — see `shopOpen`.
   *
   * `quiet` is the one thing on top: a hold nobody pressed (see `holdForMenu`)
   * moves the same switch and writes no line in the feed. It is an argument
   * rather than a second message because it is the same state change — a second
   * message would be a second kind of stopped world on the wire, which is
   * exactly what the hold is written to avoid.
   */
  setPaused(paused, quiet = false) {
    this.net.send('pause', { paused: !!paused, quiet: !!quiet });
  }

  /**
   * The hour, and the two states that are now worn by things already on screen.
   *
   * Both switches used to be pips beside the clock. They are the clock itself
   * and the panel's left edge now — see the notes in `index.html` for why — and
   * the thing that made that possible is that neither pip was ever carrying the
   * state anyway: a struck-through clock and a hot chip in #hq both already said
   * SHUT, and the accent blink already said HELD. So each element wears the
   * state it was wearing and the press is the way out of it, which leaves the
   * verb — the one half a glyph never told anybody — in `title`, where it was.
   *
   * The pair are read from different fields on purpose and that has not changed:
   * `shutters` is yours and `isOpen` is that AND the trading day, so at 22:00
   * with the shutters up the clock is struck through while the edge stays lit.
   * Reading one for both would have the edge go out every night, on a shop you
   * had not closed.
   */
  setClock(state) {
    this.el.clockTime.textContent = clockLabel(state.time * 24);

    this.shopOpen = state.shutters ?? state.isOpen ?? true;
    this.paused = !!state.paused;

    // Ask for the shutters only while they are down AND nobody has ever worked
    // them. It is in the key rather than written every frame for the reason the
    // doorway's `innerHTML` is: this whole block is a couple of writes a day.
    const ask = !this.shopOpen && !this.shutterUsed;

    // THE STATE CLASSES ARE WRITTEN EVERY SNAPSHOT, ABOVE THE KEY.
    //
    // Everything below the guard is a string: an `innerHTML`, a `title`, an
    // `aria-label`, the words painted on the sign. Those are worth a key — they
    // are a couple of writes a day and they churn the DOM. These four are
    // `classList.toggle(name, boolean)`, which is idempotent, costs nothing when
    // the answer has not moved, and is the entire state of the window's own
    // frame (`#edge`) and the clock.
    //
    // Behind the key they were a latch with no way out. `_clockKey` says "the
    // DOM has already been told this", and any single tick where that is untrue
    // — a throw between the stamp and these lines, a class removed by something
    // else, a repaint that never ran — is not a flicker: it is permanent, for
    // exactly as long as the shop stays in the same state. What that looks like
    // is a blue band round a shop that is open, with open, close, start and stop
    // all doing nothing about it, because none of those is a way of asking the
    // question again — they are the question, and the answer was cached.
    //
    // A live shop had it: `isOpen: true` on the wire, `body.shut` on the page.
    // Written every tick it cannot outlive one snapshot.
    //
    // `isOpen` and not `shutters`, exactly as the strike-through does: what it
    // marks is "nobody can be served right now", which is true at 22:00 with the
    // shutters wide open. Two marks for one state have to be read off one field.
    // `asking` rather than `nudge`, which is the build strip's scroll arrow and
    // is a BARE class — see the note beside `#sign.asking` in index.html for
    // what it did to the door. A state class on an element with an id-scoped
    // rule still lands in the same global namespace as every other class here.
    this.el.shutter.classList.toggle('asking', ask);
    this.el.clock.classList.toggle('shut', !state.isOpen);
    this.el.clock.classList.toggle('paused', this.paused);
    document.body.classList.toggle('shut', !state.isOpen);
    document.body.classList.toggle('held', this.paused);

    const key = `${!!state.isOpen}|${this.shopOpen}|${this.paused}|${ask}`;
    if (key === this._clockKey) return;
    this._clockKey = key;
    const spc = pillDrives() ? '' : ' (Space)';
    this.el.clock.title = this.paused ? `Start the clock${spc}` : `Stop the clock${spc}`;
    // Named as well as drawn: the button's words are an hour, which says nothing
    // about what pressing it does — the same reason `#sign` beside it carries an
    // explicit label rather than leaning on `tip.harvest`.
    this.el.clock.setAttribute('aria-label', this.el.clock.title);
    // The glyph names the PRESS, the way a media control does: bars while the
    // clock runs, a triangle while it does not. Inside the `_clockKey` guard, so
    // this is a couple of writes a day rather than ten a second.
    this.el.clockPP.innerHTML = this.paused ? ICONS.play : ICONS.pause;

    this.el.shutter.classList.toggle('shut', !this.shopOpen);
    const oKey = pillDrives() ? '' : ' (O)';
    this.el.shutter.title = this.shopOpen ? `Close the shop${oKey}` : `Open the shop${oKey}`;
    // The button's own words are the day and the balance, which say nothing
    // about what pressing it does — so unlike every icon-only control in here,
    // this one has to be labelled explicitly rather than by `tip.harvest`.
    this.el.shutter.setAttribute('aria-label', this.el.shutter.title);
    // The sign in the door, in the words that are painted on one. Written only
    // inside the `_clockKey` guard above, so this is a couple of writes a day
    // rather than ten a second.
    //
    // `textContent` and a word, where this used to be an `innerHTML` and a door
    // glyph. A glyph can only ever say that a state changed; which state it is
    // has to be learnt by seeing the other one, and an open/closed sign is
    // precisely the object in a shop that exists to be read by somebody who has
    // never been in. Capitalised by CSS, so the string stays a word.
    // SHUT rather than CLOSED, and it is the length that chose it: four letters
    // against four means the plaque is the same size in both states, so there is
    // no height to hold still and nothing that can jog. It is also the word the
    // rest of the game already uses for this — `shopOpen`, `#clock.shut`, "the
    // shutters" — so the sign and the code say the same thing.
    this.el.doorway.textContent = this.shopOpen ? 'Open' : 'Shut';
  }

  /**
   * The three live gauges in the corner, and the one rule all of them keep.
   *
   * **An amber step is a threshold the sim acts on, never a round number.**
   * Mood's is at 0.5 because that is where the sim decides a shopper looks
   * annoyed, so the bar changes colour on the tick the first face does. Room's
   * are the crush `CROWD_FROM` actually charges for. Two readouts of one number
   * that disagreed about when it went bad would be worse than having only one,
   * and a bar that went amber somewhere the shop was still fine is a warning you
   * learn to ignore.
   *
   * Reputation was the exception and was *always green* — the CSS paints
   * `.repwrap > div` with `--good` and this was the one of the three that never
   * overrode it. Not an oversight so much as a missing line to point at: `pull`
   * is reputation, smoothly, so nothing in the sim ever says "this is now bad".
   * `repSettle` is that line — see the note where it goes on the wire. At or
   * below it the shop is being held up by the town forgetting rather than by
   * anything it sold, which is worth a colour.
   *
   * Room counts *down* to the door closing rather than up from empty, so it
   * reads the same way as the two bars above it — long is good.
   */
  setGauges(state) {
    /**
     * Red at or under the settle floor, amber under half the town, else green.
     *
     * The upper step is the one number reputation can honestly be read as: `pull`
     * IS reputation, so 50% means half of everybody in range picks this shop.
     * Under that you are losing more of the town than you are keeping, which is
     * amber rather than red because it is a shop with a problem rather than a
     * shop in a hole.
     *
     * The floor is the preset's and arrives on the wire, so this bar means the
     * same thing in a relaxed world and a hard one — 30% is a shop being carried
     * by the floor in the first and an ordinary bad week in the second. Falls
     * back to the gentle 0.35 for a server that predates the field, which keeps
     * a stale tab honest rather than colourless.
     */
    const rep = state.reputation ?? 0;
    const settle = state.repSettle ?? 0.35;
    this.el.rep.style.width = `${Math.round(rep * 100)}%`;
    this.el.rep.style.background = rep >= 0.5 ? 'var(--good)'
      : rep > settle ? 'var(--warn)' : 'var(--accent)';

    const mood = state.mood ?? 1;
    this.el.mood.style.width = `${Math.round(mood * 100)}%`;
    this.el.mood.style.background = mood >= 0.5 ? 'var(--good)'
      : mood >= 0.2 ? 'var(--warn)' : 'var(--accent)';

    const room = Math.max(0, Math.min(1, 1 - (state.occupancy ?? 0) / (state.turnAwayAt ?? 1.35)));
    const shut = room <= 0;
    // Out of room, the bar has nothing left to say with length — a 0%-wide bar
    // is just an empty track, and an empty track is what "no data" looks like.
    // So it fills instead and pulses: not a quantity any more, an alarm.
    // Traffic light, and the thresholds are the crush the sim actually charges
    // for rather than round numbers: amber is where `CROWD_FROM` starts taking
    // mood and reputation, red is the last quarter before the door shuts. A bar
    // that went amber somewhere the shop was still fine is a warning you learn
    // to ignore.
    this.el.full.style.width = shut ? '100%' : `${Math.round(room * 100)}%`;
    this.el.full.style.background = shut ? 'var(--accent)'
      : room >= 0.48 ? 'var(--good)'
        : room >= 0.25 ? 'var(--warn)' : 'var(--accent)';
    this.el.full.classList.toggle('shut', shut);
  }

  /**
   * The footfall overlay, hung off the one thing that knows both halves.
   *
   * The map lives on the scene (`scene.heat`) because it is drawn there and
   * sized by the layout; which world it belongs to and whether it is up live
   * out here, because neither is a rendering question. `syncFootfall` is the
   * join, and it runs off the snapshot for a reason worth keeping: the map
   * cannot be loaded until the layout has told the scene how big the world is,
   * and that is a message rather than a moment.
   */
  syncFootfall() {
    const heat = this.scene?.heat;
    if (!heat || !(heat.w > 0)) return;
    // Whether the overlay is UP is all this side still owns. The map itself
    // comes off the wire and is saved with the shop — see `heat.adopt` — so
    // there is nothing here to load, nothing to write and nothing that can
    // disagree with what the crew are reading.
    //
    // Marked by the WORLD rather than by a boolean, or joining a second shop in
    // one session inherits the first one's switch state without asking.
    //
    // `footfallFor` and NOT `heatFor`, which is already a method on this class —
    // the demand multiplier behind an item's heat pill. Assigning a field over
    // it turned every row in the supplier into `ui.heatFor is not a function`,
    // from a feature in a different menu that had never been opened.
    if (this.footfallFor !== this.worldId) {
      this.footfallFor = this.worldId;
      heat.setVisible(footfallShown());
    }
  }

  /** The switch. Repaints the panel itself — see `switchGrid` on why. */
  toggleFootfall() {
    const heat = this.scene?.heat;
    if (!heat) return;
    const on = !heat.on;
    heat.setVisible(on);
    setFootfallShown(on);
    this.paintSection();
  }

  update(state) {
    // The fixture menu reads stock, queues and hoppers straight out of here.
    this.state = state;
    this.syncFootfall();
    // Somebody the other player let go while you were watching them. The scene
    // falls back to you on its own, but the flag has to go too or the menu of
    // the next hire you open says Unfollow.
    if (this.follow && !(state.roster ?? []).some((e) => e.id === this.follow)) this.setFollow(null);
    this.el.cash.textContent = money(state.cash);
    // How deep the shop's build stack is, both ways. Mirrored rather than
    // counted — see `syncSteps`. `syncLeave` is what redraws the pair, and it
    // already runs off the same tick as the two thumb buttons beside them.
    this.undos = state.undos ?? 0;
    this.redos = state.redos ?? 0;
    // The weekday, then the count. A shop that only ever said "Day 62" could
    // tell you how long you had been at it and never where you were in the
    // week, which is the question the report's own week and the reputation it
    // draws are both asked in — and the answer was already in the day number,
    // because a season IS a week (`shared/clock.js`). Derived rather than sent:
    // the snapshot carries `day` and always has, so this costs no field on the
    // wire and no field on the save.
    this.el.dow.textContent = weekdayLabel(state.day);
    this.el.day.textContent = `Day ${state.day}`;
    this.el.season.textContent = state.season;
    // The reputation bar moved into `setGauges` with the other two, because it
    // grew a colour and the rule about what an amber step may be is stated once
    // there for all three. Setting the width here as well would be two writers
    // for one bar, which is how the length and the colour end up a tick apart.
    // The town: how many are in here, out of how many could be.
    //
    // The pair is the point. Catchment on its own read as a fact about the map
    // rather than as the ceiling on your trade — the headcount beside it is the
    // same number's near end, and it moves every minute you watch it. That
    // argument was written when the town stepped a handful of times in a whole
    // game; it now banks a little every morning the shop traded (see
    // `TOWN_PER_DAY`), which makes the pair better rather than redundant: the
    // slow half finally moves, and the fast half is still what says whether the
    // shop is anywhere near using it.
    //
    // Still written only when either half changes: this runs at 10Hz over a live
    // canvas, and one of the two is now a number that actually moves — which is
    // exactly when a key beats a blind write.
    const town = Math.round(state.catchment ?? 0);
    const here = Math.round(state.inShop ?? 0);
    const room = state.room ?? null;
    // What share of the town walks in. It is `reputation × world events`, which
    // is the answer to "does rep decide how many people come" — it decides
    // nothing else, and it is the only percentage on this panel that is a rate
    // rather than a level, hence a second line rather than a fourth bar.
    const share = Math.round((state.pull ?? 0) * 100);
    const townKey = `${here}/${room}/${town}/${share}`;
    if (townKey !== this._town) {
      this._town = townKey;
      this.el.town.querySelector('b').textContent = String(here);
      // Against what the BUILDING holds. A shop with no floor and no till has no
      // capacity to be out of, so the pair collapses to a headcount rather than
      // printing "/null" — which is every headless game and a brand new world
      // for the tick before its shell is stamped.
      this.el.town.querySelector('.of').textContent = room ? `/${room}` : '';
      this.el.town.querySelector('.tw').textContent = `${town} town · ${share}%`;
      // On the element rather than in the markup, because the sentence names
      // the numbers — see `tip.js`, which adopts any `title` in the HUD.
      this.el.town.title = `${here} in the shop${room ? `, which holds about ${room}` : ''}. `
        + `${town} people are within reach and your reputation brings ${share}% of them in — `
        + 'milestones, parking, charm and a better address all grow the town';
    }
    this.setGauges(state);

    this.setClock(state);

    const me = state.players.find((p) => p.id === this.net.myId);
    // ...and what to do with it, because that is the half nothing else on screen
    // says. An armful used to leave your hands for standing in the wrong place,
    // so "carrying six loaves" was the whole story; now it goes where you point
    // it, and the chevrons showing which shelves will take it are no use to
    // somebody who does not know a tap is what spends them.
    // A crate says something different from an armful, and the difference is
    // the thing a player has to be told: your hands are full of box, so the
    // chevrons are gone and the only move is to put it down. "Tap where it
    // goes" would be a lie — there is no shelf that will take it from here.
    // "Hold", not "tap", and it is the honest verb for both: pointing at a
    // square NAMES it and the ring is what spends it, which is the one thing
    // about putting goods down that nothing else on screen can say. An armful
    // keeps the tap in front of it, because a tap on a shelf is still the common
    // way to spend one and the chevrons are already pointing at those.
    // A crate says the same sentence an armful does now: the chevrons are up for
    // it (`takers` reads both hands and shoulder) and a shelf pours it straight
    // off the box, so "the only move is to put it down" stopped being true.
    // What is in your hands, a row per pile — see `setCarry`.
    this.setCarry(me?.haul ?? null, me?.carry ?? null);
    this.setStamina(me);
    this.updatePrompt(me?.action ?? null);
    // Which seed is chosen is the SERVER's answer, mirrored down rather than
    // kept alongside. Two copies of it disagreed in both directions: sowing
    // from a bed's own menu is a choice ("choosing it here is choosing it", in
    // `sow`) that never reached the picker, and the client's own copy could be
    // pushed back up over it. The one it decides is the auto-replant, so a
    // stale copy is a bed that comes back as something you did not ask for and
    // a seed you paid for — see `setCatalog`.
    if ((me?.selectedCrop ?? null) !== this.selectedCrop) {
      this.selectedCrop = me?.selectedCrop ?? null;
      this.renderHotbar();
    }
    this.ownedUpgrades = state.ownedUpgrades ?? this.ownedUpgrades;
    // The build bar shows how many of each you own. Keeping it here rather
    // than only in the bar means the rail's badges can read it too.
    this.fixtureCounts = state.fixtures ?? this.fixtureCounts;
    // Placing one is exactly when that count moves, and nothing else redraws the
    // bar for it — hands are empty on either side of a build. Compared as a
    // string first, because this runs at 10Hz over a live canvas.
    // …and what you can AFFORD moves the same way, for the same reason: a tile
    // greys out when the money for it goes and comes back when it arrives, and
    // nothing else on this bar redraws for a sale. Bucketed rather than the
    // figure itself (`affordStep`) — cash moves every tick a shopper pays, and
    // rebuilding the strip at 10Hz would throw the DOM away under the pointer.
    const counts = JSON.stringify([this.fixtureCounts ?? {}, this.affordStep(state.cash ?? 0)]);
    if (this.bar === 'build' && counts !== this._countKey) {
      this._countKey = counts;
      this.renderHotbar();
    }

    // The roster bar says what each person is doing right now, which is the
    // whole reason to have it up — so it follows the snapshot on the same terms:
    // a signature of exactly what it draws, compared as a string, redrawn only
    // when that moves rather than ten times a second over a live canvas.
    if (this.bar === 'staff') {
      const who = JSON.stringify([
        (state.roster ?? []).map((e) => [e.id, e.name, e.kind]),
        // `lotTotal` rather than one pile's number: a hire who swapped a pile
        // for another of the same size would keep a stale roster line, and the
        // line prints what they are carrying.
        (state.players ?? []).filter((p) => p.staff)
          .map((p) => [p.hire, p.job, lotTotal(p.carry), p.pastime]),
        // Who you can afford to take on, on the same terms as the palette.
        this.affordStep(state.cash ?? 0),
      ]);
      if (who !== this._staffKey) { this._staffKey = who; this.renderHotbar(); }
    }

    // The upgrades bar had a branch here — it shipped drawn once and never
    // redrawn, so buying something left the tile saying the price next to a
    // menu that said Owned: yes. The list is a panel section again and
    // `paintSection` already does exactly this off the section's own `live`,
    // which is the general answer this was a special case of.

    // A menu that belongs to one thing — a fixture, a hire — is a live window
    // onto it. Whatever opened it left a tick behind that redraws it when what
    // it shows moves, and only then. One hook rather than a branch per kind of
    // menu here, so the next one costs this file nothing.
    this.panelTick?.(this);

    // A lifted fixture changes what the ghost is and what the hint says, so the
    // bar has to follow the server's idea of what's in your hands, not ours.
    const heldId = me?.holding?.id ?? null;
    if (heldId !== this._heldId) {
      this._heldId = heldId;
      this.holding = me?.holding ?? null;
      // What's in your hands changing is a new placement decision either way —
      // one starting, or one finished — so the facing starts over with it. The
      // angle carries (a lifted unit arrives wearing its own, which is the
      // right thing for `faceAlong` to break ties toward) but the *pin* must
      // not: an R pressed twenty shelves ago would otherwise follow you into
      // the errand and stop a moved unit facing the wall you set it against.
      this.buildRot = this.holding?.rot ?? this.buildRot;
      this.rotPinned = false;
      this.renderHotbar();
      // Hands full is the lift landing. Hands empty again is the errand over,
      // however it ended — set down, put back, or the mode dropped underneath.
      if (heldId) this._lifting = false;
      else this.endMove();
    }
    this.syncBuildTool(me?.build);

    // The demand meter and the cashflow readout. Both are pure functions of a
    // slice of the snapshot (`client/hud-meters.js`), so all this owes them is a
    // signature: innerHTML at 10Hz would throw away the DOM under the cursor
    // every tick and take the hover explanation with it.
    //
    // The signature is the whole of what each draws and nothing else. `net` is
    // rounded to two places server-side, so it settles rather than jittering, and
    // a meter that redrew on `fill` — which it shows but does not draw a bar off
    // — would be redrawing on a number nobody can see move.
    const rciKey = (state.departments ?? []).map((d) => `${d.dept}${d.net}${d.event}`).join('|');
    if (rciKey !== this._rciKey) {
      this._rciKey = rciKey;
      this.el.rciRows.innerHTML = rciHtml(state.departments);
    }

    const flowKey = `${state.stats?.revenue}/${state.stats?.spent}/`
      + (state.ledger ?? []).map((d) => `${d.day}:${d.revenue}-${d.spent}`).join(',');
    if (flowKey !== this._flowKey) {
      this._flowKey = flowKey;
      this.el.flow.innerHTML = cashflowHtml(state.stats, state.ledger);
    }

    // innerHTML at 10Hz would throw away the DOM under the cursor every tick,
    // so redraw only when the list actually reads differently.
    const todo = this.todoList(state);
    const key = todo.map((t) => t.icon + t.text).join('|');
    // Outside the redraw guard on purpose: the words are what the guard diffs
    // on, so an identical list about a *later* snapshot does not rebuild the DOM
    // — and a run captured at the last rebuild would then be acting on a shop
    // several seconds old. Same rule the pill's rows keep (see `paintPrompt`).
    this._todoRuns = todo.map((t) => t.run ?? null);
    if (key !== this._todoKey) {
      this._todoKey = key;
      // A `<button>` where there is something to press and a `<span>` where
      // there is not, which is the pill's rule again: a chip that looks
      // pressable and is not is the green ghost with words on it.
      this.el.todo.innerHTML = todo
        .map((t, i) => (t.run
          ? `<button type="button" class="todo${t.hot ? ' hot' : ''}" data-i="${i}">`
            + `${ICONS[t.icon]}${t.text}</button>`
          : `<span class="todo${t.hot ? ' hot' : ''}">${ICONS[t.icon]}${t.text}</span>`))
        .join('');
    }

    // The sections and the plot's seed picker read these when they paint, so
    // keep them fresh — and set them before anything asks a section to redraw.
    this._season = state.season;
    this._cash = state.cash;

    this.rail.update();
    this.markBuilding();
    // On the snapshot as well as at the moment a tool is armed, because two of
    // the three things it reads are not presses: picking a fixture up is the
    // server answering, and turning the phone sideways can cross `pillDrives`
    // with nothing having happened in the shop at all. It early-returns unless
    // the answer moved, so 10Hz costs a boolean.
    this.syncRotate();
    // An open section is a live window too. Each one declares a signature of
    // everything its rows read; redraw only when that moves, not at 10Hz.
    const sec = sectionById(this.openPanel);
    if (sec?.live) {
      const key = sec.live(this);
      if (key !== this._sectionKey) {
        this._sectionKey = key;
        this.paintSection();
      }
    }

    if (state.log?.length) {
      // Two questions, not one. A new `id` is a new event and gets its own line;
      // the SAME id with a different `msg` is a line the shop amended — see
      // `logGoods` — and has to repaint the line already on screen rather than
      // stack a second copy of it on top.
      const last = state.log[state.log.length - 1];
      if (last.id !== this._lastLog?.id || last.msg !== this._lastLog?.msg) {
        this._lastLog = { id: last.id, msg: last.msg };
        this.pushLog(last);
      }
    }
  }

  /**
   * One hire, as a picture of *that hire* — at their grade, in their skin.
   *
   * Resolved from the roster at paint time rather than stamped on the line when
   * it was written: a bot who gets promoted or repainted should look like
   * themselves in every line that names them. Nothing for a hire who has since
   * been let go, and the line keeps its words, which is why the server puts the
   * name in `msg` as well as the id in `by`.
   */
  hireArt(hireId) {
    if (!hireId) return null;
    const entry = (this.state?.roster ?? []).find((h) => h.id === hireId);
    if (!entry) return null;
    const kind = (this.catalog.workers ?? []).find((w) => w.id === entry.kind) ?? null;
    const art = artForWorker(kind, entry.tier, (this.catalog.skins ?? [])
      .find((s) => s.id === entry.skin) ?? null);
    if (!art) return null;
    const el = document.createElement('span');
    el.className = 'lg-who';
    el.title = entry.name;
    el.innerHTML = art;
    return el;
  }

  /**
   * What is in your hands, bottom right — one row per pile.
   *
   * It was one sentence, and it grew sideways: three kinds of goods ran it the
   * width of the screen and pushed the half that matters — how to put the thing
   * down — off the right-hand edge. A column cannot do that however mixed an
   * armful is, and it puts the counts under each other so "how much" is a look
   * rather than a read.
   *
   * The art is `artForModel`, the same call the log chips and the board tip
   * make. The name stays beside it: this is the one readout you consult while
   * *deciding* where to walk, and a picture of a tin at 19px is not a thing you
   * want to squint at to find out it is the soup.
   *
   * Signature-tested, because this is on the 10Hz path and rebuilding a handful
   * of rows ten times a second to redraw the same armful is work nobody sees.
   */
  /**
   * The chase bar — see docs/security.md step 3.
   *
   * Absent from the wire means full, which is the ordinary state of the shop
   * and therefore the one that should cost nothing: `stamina` is only sent when
   * it is below 1 (see the player snapshot), so this is a compare against
   * `undefined` on every frame of a game nobody is running in.
   *
   * `spent` is its own class rather than "width is zero", because being winded
   * is a STATE you are in and an empty bar alone reads as a bar that has
   * stopped working — which is exactly the confusion the hysteresis in
   * `stepPlayers` was added to prevent, arriving through the readout instead.
   */
  setStamina(me) {
    const v = me?.stamina;
    const show = v != null && v < 1;
    const key = show ? `${Math.round(v * 40)}` : '';
    if (key === this._stamKey) return;
    this._stamKey = key;
    this.el.stam.classList.toggle('show', show);
    this.el.stam.classList.toggle('spent', show && v <= 0.02);
    this.el.stam.firstElementChild.style.transform = `scaleX(${show ? v : 1})`;
  }

  setCarry(haul, carry) {
    const stacks = lotStacks(haul ?? carry);
    const key = `${haul ? 'h' : 'c'}|${stacks.map((s) => `${s.item_id}:${s.qty}`).join(',')}`;
    if (key === this._carryKey) return;
    this._carryKey = key;

    this.el.carry.textContent = '';
    // `#carry:empty` is what hides it, so empty hands must leave nothing behind.
    if (!stacks.length) return;

    const add = (cls, text) => {
      const el = document.createElement('div');
      el.className = cls;
      el.textContent = text;
      this.el.carry.append(el);
      return el;
    };

    // A crate and an armful are two different places goods can be, and the
    // difference decides what your hands can do next — see the chevrons.
    add('cy-what', haul ? 'carrying a crate' : 'carrying');

    for (const s of stacks) {
      const row = add('cy-row', '');
      const n = document.createElement('span');
      n.className = 'cy-n';
      n.textContent = `${s.qty}x`;
      row.append(n);
      const art = artForModel(this.itemById(s.item_id)?.model);
      if (art) {
        const holder = document.createElement('div');
        holder.innerHTML = art;
        // The svg itself, not a wrapper: the row's rules size a direct child.
        row.append(holder.firstElementChild);
      }
      const name = document.createElement('span');
      name.className = 'cy-name';
      name.textContent = this.itemName(s.item_id);
      row.append(name);
    }

    // "Hold", not "tap", is the honest verb for both: pointing at a square NAMES
    // it and the ring is what spends it, which is the one thing about putting
    // goods down that nothing else on screen can say. The tap stays in front of
    // it because a tap on a shelf is still the common way to spend an armful,
    // and a crate says the same sentence now — `takers` reads the shoulder too,
    // so a shelf pours it straight off the box.
    add('cy-hint', haul
      ? 'tap where it goes, or hold a square to set it down'
      : 'tap where it goes, or hold a square to put it down');
  }

  /**
   * "Harvesting…", pinned under the HUD.
   *
   * Standing in range is the whole input, so this is the only warning you get
   * that something is about to happen to the thing you are stood next to. It
   * says what, while the ring says how long you have to walk away.
   *
   * ...which was the wrong question, and the pill spent a long time answering
   * it well. `p.action` is the job the shop has ARMED, and a job is armed only
   * after you have named a target and walked to it — so this named one thing,
   * in one direction, at the one moment you had already worked out what to do.
   * Everything before that said nothing at all: point at a crate and no word
   * about picking it up, stand with a box on your shoulder looking for
   * somewhere to set it down and nothing anywhere says which button does it.
   * And the one gesture in this game nobody could ever guess — **a tap is one
   * unit, a hold is the lot** — could not be written here at all, because a tap
   * and a hold are one armed action wearing one name.
   *
   * So the pointer speaks first (`setPressHints`), and it speaks in a LIST:
   * every button, and every length of press, that means something at whatever
   * you are pointing at. Each one behind a mouse with that button pressed —
   * left-button jobs on the left of the pill, right on the right, which is the
   * whole of what the picture says.
   *
   * The armed action keeps the pill for exactly the moment it is HAPPENING —
   * `progress > 0`, a ring actually turning. That is the one time the specific
   * name is worth more than the list: it says which board is draining while it
   * drains. Standing armed and not pressing is not that moment, and it is the
   * state the old pill spent nearly all its time in.
   *
   * Same pill, same place, same words. What is new is when it speaks and how
   * many things it has to say.
   */
  setPressHints(hints) {
    // POINTING AT THE PILL IS NOT POINTING AWAY FROM THE THING IT IS ABOUT.
    //
    // The list is re-derived from the pointer every frame, and reaching for one
    // of its rows takes the pointer off the shop — so by the time it arrived the
    // aim had gone, the list was empty, and the button under the cursor was a
    // dead row of a card in its guard. Every single press missed, and it missed
    // in the way that is hardest to read: the words were still there.
    //
    // A finger does not have this problem and that is exactly why it survived
    // being tried — a tap on the pill fires no canvas move, so the aim sticks.
    // It is the same bug either way, though: the pill is a control ABOUT
    // something, and a control cannot be about a thing that stops existing when
    // you go to use it.
    //
    // So an empty update is refused while the pointer is on the pill. Only an
    // empty one: a list that changed to a different list is a real answer about
    // a real target and must land, or the rows would freeze under your hand.
    if (!hints?.length && this._overPill && this._hints) return;
    this._hints = hints?.length ? hints : null;
    this.paintPrompt();
  }

  updatePrompt(action) {
    // Only while the ring is turning. `progress` is sent from the tick it arms
    // at zero, which is the whole armed-but-idle state the hints are better at.
    this._doing = action && action.progress > 0 ? action : null;
    this._prog = action?.progress ?? 0;
    this.paintPrompt();
    this.markPress();
  }

  /**
   * How far through the row you are holding is, painted on the row itself.
   *
   * A hold is the one gesture in this game with no clock on it anywhere the eye
   * is: in the world the ring winds on the thing you are pointing at, which is
   * where you are already looking — and on the pill you are looking at a button
   * at the bottom of the screen while the ring turns somewhere behind your
   * thumb. So the button fills, left to right, and the fill IS the ring: the
   * same number, off the same `action.progress` the shop sends.
   *
   * Written straight onto the node rather than through `paintPrompt`, and that
   * is the whole reason this is its own method. The card is rebuilt from
   * `innerHTML` whenever what it SAYS changes, so anything carried in that
   * rebuild is lost and re-derived several times a second — a class went on and
   * came off between repaints and read as a button flickering under a finger
   * that had not moved. A property set on a node that is already there survives
   * until the words themselves change, which is exactly the life a press has.
   */
  markPress() {
    const rows = this._rowEls ?? [];
    rows.forEach((el, i) => {
      const on = i === this._pressed;
      el.classList.toggle('pr-busy', on);
      // Clamped, because a repeat pull reports its own cycle and can arrive at
      // slightly over 1 between ticks — a fill wider than the button paints past
      // its rounded corner, which reads as the chip having broken rather than as
      // a bar that is full.
      el.style.setProperty('--pr', on ? String(Math.max(0, Math.min(1, this._prog ?? 0))) : '0');
    });
  }

  paintPrompt() {
    const doing = this._doing;
    // A ROW YOU ARE HOLDING MUST NOT LEAVE WHILE YOU HOLD IT.
    //
    // An armed action used to replace the whole list with one line naming it,
    // which is right for a press made in the world — your hand is on the shop,
    // and the pill is the only thing that can say what is happening. It is
    // exactly wrong for a press made ON the pill: the button under your finger
    // is deleted the instant it starts working, the card resizes to one row, and
    // what is left is a label where the thing you were pressing was. Letting go
    // early is a real part of this gesture (half a hold is half a board), so the
    // one moment you most need that button to still be there is the one moment
    // it went away.
    //
    // So a pill press keeps its list and marks the row instead. `_pressed` is
    // the row the pointer went down on, which is the only thing that can tell
    // the two cases apart — `doing` says what is running, never who started it.
    const own = this._pressed != null && this._hints?.[this._pressed] ? this._pressed : null;
    const hints = doing && own == null
      ? [{ btn: doing.btn === 'right' ? 'r' : 'l', tag: null, say: `${doing.label}…` }]
      : this._hints;
    // The mark is NOT in this key, and must not be: it goes on the node in
    // `markPress` precisely so that holding a button is not a reason to rebuild
    // the card under the finger holding it.
    // ...and whether a row is GREY is in it, which is the one thing here that
    // is easy to leave out and impossible to see missing: a row that goes off
    // and on keeps its words, so without this the card is not rebuilt and the
    // button stays lit over a press the shop now refuses — the green-ghost bug
    // with the fix for it in the same function.
    // The name of the unit the rows are about, when there is one — see the call
    // site. It is in the key, or pointing at the freezer next to the freezer you
    // were on keeps the first one's name over the second one's rows: every row
    // reads identically between two units of a kind, so the words alone cannot
    // tell them apart and this is the only part of the card that can.
    const about = (doing && own == null ? null : this._hints?.about) ?? null;
    const key = hints
      ? `${about ?? ''}#${hints.map((h) => `${h.btn}${h.tag ?? ''}${h.off ? '!' : ''}:${h.say}`).join('|')}`
      : null;
    if (key === this._promptKey) return;
    this._promptKey = key;

    if (!hints) {
      // ...and it goes on SWALLOWING presses for a moment after it goes.
      //
      // The rows are buttons on a touchscreen, so the pill is a stack of targets
      // that appears and disappears under your thumb as the aim changes — and
      // the moment it leaves is exactly the moment somebody is pressing at it.
      // What that press lands on is the shop floor behind it, which is never
      // nothing: it walks you somewhere, opens a unit, or spends an errand you
      // did not mean to make. It reads as the game doing something at random,
      // because from where you are sitting you pressed a button.
      //
      // So for `PROMPT_GUARD_MS` the pill keeps the pointer and does nothing
      // with it. Both halves are needed and neither is enough: it takes the
      // press (`.guard` gives the element itself `pointer-events`, which it
      // never has otherwise) and the press cannot fire a row either, because
      // `_hints` is already null and the handler looks the run up there rather
      // than capturing it. A guard that only hid the rows would let the tap
      // through; one that only kept them would run the verb you were too late
      // for.
      //
      // Short enough that it can never be the reason a deliberate press did
      // nothing: it is about the tap that was already on its way.
      this.el.prompt.className = 'hud guard';
      this.measurePill();
      clearTimeout(this._promptGuard);
      this._promptGuard = setTimeout(() => {
        this.el.prompt.className = 'hud';
      }, PROMPT_GUARD_MS);
      return;
    }
    clearTimeout(this._promptGuard);

    this.el.prompt.textContent = '';
    // The nodes, so `markPress` can paint a press onto one without a rebuild.
    this._rowEls = [];
    // One listener on the pill rather than one per row, because this element is
    // rewritten every time the pointer moves onto something else — a handler
    // bound to a row would be thrown away several times a second. The index is
    // read back out of `this._hints` at press time and never captured: the words
    // are what `_promptKey` diffs on, so an identical list about a DIFFERENT
    // shelf does not rebuild the DOM, and a captured thunk would then be aimed
    // at the unit you were pointing at a moment ago.
    if (!this._promptWired) {
      this._promptWired = true;
      // Whether the pointer is on the card, which is what `setPressHints` needs
      // to tell "you looked away" from "you reached for a button". `pointerover`
      // rather than `mouseenter` so a pen and a finger count, and cleared on
      // `pointerleave` (which does not fire crossing between children the way
      // `pointerout` does).
      this.el.prompt.addEventListener('pointerover', () => { this._overPill = true; });
      this.el.prompt.addEventListener('pointerleave', () => { this._overPill = false; });
      // Half of these rows have to be HELD, and a long press on a control is
      // also how a browser is asked for its own menu — so the gesture the pill
      // is built around is the one gesture that puts Chrome's context menu over
      // it, mid-ring. The canvas has refused this since the first fixture menu
      // (see `contextmenu` in client/main.js); the pill is the second surface in
      // the game where a press is measured in how long it lasts, so it refuses
      // it for exactly the same reason. `touch-action` and the callout are the
      // other two halves and live in the stylesheet, on the rows.
      this.el.prompt.addEventListener('contextmenu', (e) => e.preventDefault());
      // `pointerdown` and NOT `click`, which is the whole of what makes a held
      // row a hold: a click fires on release, so holding the button did nothing
      // until you let go and then behaved exactly like a tap. Firing on the way
      // down means the ring winds under your finger and letting go part way
      // leaves you with part of the board — the real gesture. A tap is still the
      // whole action; see `pillLetGo` in client/main.js for who owns the
      // release. `preventDefault` because the row is inside a fixed overlay and
      // the browser would otherwise start a text selection under the press.
      this.el.prompt.addEventListener('pointerdown', (e) => {
        const row = e.target?.closest?.('.pr-say');
        if (!row || e.button > 0) return;
        e.preventDefault();
        const h = this._hints?.[Number(row.dataset.i)];
        // A GREY ROW STILL ANSWERS, which is the whole difference between a
        // button that is off and a button that is broken. It is the same
        // sentence the shop would have said to the press it is standing in for
        // (see `off` in `pressHints`), moved to the moment you ask for it — and
        // it is why the row is `aria-disabled` rather than `disabled`, since a
        // disabled control is not sent the press at all.
        if (h?.off) { this.toast(h.off, true); return; }
        if (!h?.run) return;
        // A HOLD ROW IS NOT ARMED UNTIL THE PRESS IS ONE, and that is the whole
        // of what makes a quick tap on it do nothing *visible*. It already did
        // nothing to your goods — the release comes long before the ring lands —
        // but firing on the way down still SENT the errand, and an errand is a
        // change: the shop re-answers what the pointer is on, the row you were
        // aiming at is no longer offered, and the pill goes. So a tap read as
        // "the button worked once and then vanished", which is worse than a
        // button that refuses, because there is nothing left on screen to press
        // again.
        //
        // Well under `LONG_PRESS_MS` (420ms, client/main.js): this is not a
        // second definition of a hold, it is the shortest press that is
        // obviously not a tap. Every millisecond here is one the ring does not
        // get, and the ring is the part somebody is waiting through.
        // Which row is being worked, for `paintPrompt` — set for both kinds,
        // because a tap row's action is short and still repaints the pill under
        // the finger that made it.
        this._pressed = Number(row.dataset.i);
        this.markPress();
        if (h.tag === 'hold') {
          clearTimeout(this._pillArm);
          this._pillArm = setTimeout(() => { this._pillArm = 0; h.run(); }, HOLD_ARM_MS);
          return;
        }
        h.run();
      });
      // A press that ended before it was a hold never happened. On the window,
      // because a finger that slid off the row before lifting has still let go.
      const drop = () => {
        clearTimeout(this._pillArm); this._pillArm = 0;
        this._pressed = null;
        this.markPress();
      };
      addEventListener('pointerup', drop);
      addEventListener('pointercancel', drop);
    }
    // The subject, in front of its verbs. First child rather than a line above,
    // because the card is one row of chips and a second row would move the rows
    // themselves down the screen every time the name appeared or went — which is
    // the thing `#build` sizing already has to animate around, arriving under
    // the pointer this time. It is a `span` and never a button: it is the one
    // part of the card that is not a press.
    if (about) {
      const who = document.createElement('span');
      who.className = 'pr-about';
      who.textContent = about;
      this.el.prompt.append(who);
    }
    hints.forEach((h, i) => {
      const right = h.btn === 'r';
      // Both buttons, one sentence — see `add` in `pressHints`. A mouse on each
      // outside edge says the same thing the two chips said, in the space of
      // one: the side is still doing the talking, there is just nothing left to
      // divide. No `pr-r`, because a reversal is what puts a lone mouse on its
      // own edge and this row has both edges spoken for.
      const both = h.btn === 'lr';
      // ...and a row whose press is a KEY, which is neither. See `keyCap`.
      const keyed = h.btn === 'k';
      // A BUTTON when there is a press behind it, and a span when there is not:
      // the armed-action line (`doing`) is a statement about what is happening,
      // and a thing that looks pressable and is not is the green-ghost bug with
      // words on it. `type="button"`, or it is a submit inside nothing.
      // ...and a GREY row is a button too, which is the point of it: it holds
      // its place in the card so the list does not reshuffle under your thumb
      // every time your hands fill, and it takes the press so it can say why.
      const row = document.createElement(h.run || h.off ? 'button' : 'span');
      if (h.run || h.off) { row.type = 'button'; row.dataset.i = String(i); }
      this._rowEls.push(row);
      // `pr-r` is a `row-reverse`, so a right-button job puts its mouse on the
      // right of its own words. The side is doing the talking, and a right
      // press drawn glyph-first would argue with the only thing this says.
      // ...and `pr-k` so the stylesheet can find the keyed row. It is the one
      // row that is not a mouse button, which on a phone is the one row whose
      // cap is hidden — so without a class on it there is nothing left in the
      // markup to tell it from an ordinary left-hand row. See the pairing rule
      // in index.html: R is a *modifier* on the unit you just chose to move, not
      // a third thing to do to it, and the layout says so by putting them on one
      // line.
      row.className = `pr-say${right ? ' pr-r' : ''}${keyed ? ' pr-k' : ''}${h.off ? ' pr-off' : ''}`;
      // Said to a screen reader as well as drawn, and `aria-disabled` rather
      // than `disabled` on purpose — see the press handler above: the row still
      // has to be sent the press, or the reason it is grey has nowhere to come
      // out. On a desktop nothing is pressing it (the pill is a caption there,
      // `pointer-events: none`) and the shop says the same sentence itself when
      // you make the press in the world, so the grey is the whole of it.
      if (h.off) row.setAttribute('aria-disabled', 'true');
      // A proximity job — a till with somebody at it, the bed under your feet —
      // belongs to neither button (`p.pressing` is one bit that says a button is
      // down and nothing about which), so it gets no mouse rather than one with
      // neither cap lit, which would read as a third state nobody can make.
      if (keyed) row.append(keyCap(h.tag));
      else if (!doing || doing.btn) row.innerHTML = mouseGlyph(both ? false : right);
      // What makes it something other than a click: how long you hold it, or how
      // many of them. Said in a word rather than drawn, because there is no
      // picture of "twice" that anybody reads as twice.
      //
      // A keyed row has already spent its tag on the cap above — printing it
      // again here would be the letter twice, once as a key and once as a
      // caption, which reads as two different facts about the same press.
      if (h.tag && !keyed) {
        const tag = document.createElement('i');
        tag.className = 'pr-hold';
        tag.textContent = h.tag;
        row.append(tag);
      }
      const b = document.createElement('b');
      b.textContent = h.say;
      row.append(b);
      // The second mouse, after the words rather than before them. `beforeend`
      // on the row itself, because the glyph is markup and the rest of this loop
      // is nodes — the same call `mouseGlyph` is already made with above.
      if (both && (!doing || doing.btn)) row.insertAdjacentHTML('beforeend', mouseGlyph(true));
      this.el.prompt.append(row);
    });
    // A rebuild throws away whatever was marked, so the press is put back on
    // whichever node now sits at that index — the words are the same or this
    // would not be the same press.
    this.markPress();
    // Keep `hud` — it carries position:fixed, and dropping it drops the
    // element out of the overlay and into the document flow, invisible.
    this.el.prompt.className = 'hud show going';
    // ...and tell the carry card how much room this just took. After the class,
    // because the height is only real once it is displayed.
    this.measurePill();
  }

  /**
   * The bottom-left event feed.
   *
   * A line used to leave only when six newer ones shoved it off the bottom,
   * which in a quiet shop is never — so the last handful of deliveries stayed
   * on screen indefinitely and read as messages that were stuck. Each line now
   * ages out on its own clock; the six-line cap is only there for a busy
   * minute, and a line evicted that way goes at once rather than fading,
   * because its slot is already spoken for.
   */
  pushLog(e) {
    // An amended line keeps its slot and gets its clock back. Moving it to the
    // top would be the shop's fifth order shoving the fourth one's line off the
    // bottom, which is the pile this exists to stop.
    const top = this.el.log.firstChild;
    const line = (e.id != null && top?._logId === e.id)
      ? (clearTimeout(top._timer), top)
      : document.createElement('div');
    line._logId = e.id;
    this.paintLogLine(line, e);
    if (line !== top) this.el.log.prepend(line);

    this.ageLogLine(line);
    while (this.el.log.children.length > 6) this.dropLogLine(this.el.log.lastChild);
  }

  /** Start (or restart) a line's seven seconds. */
  ageLogLine(line) {
    clearTimeout(line._timer);
    line._timer = setTimeout(() => {
      line.classList.add('out');
      line._timer = setTimeout(() => line.remove(), 300);
    }, 7000);
  }

  /**
   * Point at a line and it stays until you look away.
   *
   * Hit-tested against the lines' own rectangles rather than done with
   * `:hover`, because that would need the feed to take the pointer — and the
   * feed sits in the bottom-left corner of the *floor*, so every pill would be
   * a patch of shop you cannot tap to walk to. (It was, until this: `#log` had
   * no `pointer-events` rule, so it swallowed presses, and a press that lands
   * on nothing reads as a press you got wrong rather than as a UI bug.) This
   * reads the position the window already reports and leaves the click going
   * through to the canvas.
   *
   * Holding is the timer, not a paused animation: a line is either counting
   * down or it is not, so leaving simply restarts its seven seconds — which is
   * also the right answer for a line you nearly missed.
   */
  hoverLog(x, y) {
    let over = null;
    for (const line of this.el.log.children) {
      const r = line.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { over = line; break; }
    }
    if (over === this._logHover) return;
    // The one it WAS on may have been evicted by the six-line cap in between,
    // in which case there is nothing left to restart.
    if (this._logHover?.isConnected) {
      this._logHover.classList.remove('held');
      this.ageLogLine(this._logHover);
    }
    this._logHover = over;
    if (!over) return;
    clearTimeout(over._timer);
    over._timer = null;
    over.classList.remove('out');
    over.classList.add('held');
  }

  /**
   * A line's contents — words, or words with the goods drawn in them.
   *
   * `goods` is the same list the `msg` spells out in names (see `logGoods`), and
   * this takes the pictures instead: five items named is a sentence you have to
   * read and five icons is one you take in. The art is `artForModel`, the same
   * call the board tip and the heap on the shelf make — a glyph here would be
   * the five-floors-one-grey-icon bug again, since goods differ by their art and
   * by nothing else.
   *
   * The name goes on the `title`, so the one thing a picture cannot say is a
   * hover away, and it falls back to the whole sentence for an item whose row
   * has been deleted since the line was written.
   */
  paintLogLine(line, e) {
    line.textContent = '';

    // Who did it, as a face. The name is already in the words (`saidBy` on the
    // server), so this is the half text cannot carry — four hires reading as
    // four names is the staff-glyph bug wearing a font.
    //
    // Its own flex child beside the sentence rather than floated into it: a
    // float pins to the FIRST line, so a wrapped message left the face level
    // with the top of a two-line pill instead of level with the pill.
    const who = this.hireArt(e.by);
    if (who) line.append(who);

    const text = document.createElement('span');
    text.className = 'lg-text';
    line.append(text);
    const say = (t) => { if (t) text.append(document.createTextNode(t)); };

    const goods = Array.isArray(e.goods) ? e.goods : null;
    if (!goods?.length) { say(e.msg); return; }

    say(e.pre);
    goods.forEach((g, i) => {
      const item = this.itemById(g.item_id);
      const art = artForModel(item?.model);
      // Plain inline, NOT a flex box. A flex chip centres its own "8x" against
      // its icon, and the count then sits at a different height from the words
      // either side of it — the number shares the sentence's baseline and only
      // the picture wants centring.
      const chip = document.createElement('span');
      chip.className = 'lg-good';
      chip.title = item?.name ?? g.item_id;
      chip.innerHTML = `${g.qty}x${art ?? ''}`;
      // No art means no picture, so the name has to be in the line itself or
      // the count is standing next to nothing.
      if (!art) chip.append(document.createTextNode(` ${chip.title}`));
      if (i) say(' ');
      text.append(chip);
    });
    say(e.post);
  }

  dropLogLine(line) {
    clearTimeout(line._timer);
    line.remove();
  }

  toast(msg, bad = false) {
    this.el.toast.textContent = msg;
    // Same trap as the prompt: this used to assign 'show', which silently
    // stripped `hud` and its position:fixed — so no toast has ever actually
    // appeared, and every "shelf already holds X" went unseen.
    this.el.toast.className = `hud show${bad ? ' bad' : ''}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.el.toast.className = 'hud'; }, 2600);
  }

  /**
   * Name the pile under the pointer, and say how much of it is there.
   *
   * The gold cage answers "which one of these three heaps am I on" and can
   * never answer "and what is it": goods are drawn as themselves at about a
   * dozen pixels from this camera, so four loaves and four buns are the same
   * little pile, and the count was a number you had to open the unit to read.
   * The unit's menu still has all of it — this is the glance.
   *
   * Read off the SNAPSHOT rather than off anything the pointer remembered, so
   * the number ticks down as the shop sells out from under your cursor. A card
   * that froze the moment it appeared would be worse than none, because it
   * looks live.
   *
   * `left`/`top` are set every call because it follows the pointer, and the
   * card is nudged clear of the cursor and flipped when it would run off the
   * right or bottom edge — a tooltip that pushes the window's scrollbars out is
   * the one bug every hand-rolled tooltip ships with.
   */
  /**
   * EVERY UNIT'S CARD AT ONCE — the held-Alt overlay.
   *
   * `setBoardTip` said about the whole shop instead of about the one heap under
   * the pointer, and that reuse is the design rather than a saving. The hover
   * card already answers "what is this, how much of it, what does it cost",
   * which is exactly what the overlay asks of every unit — so a second readout
   * would be a second thing to keep in step with the item art, and a worse one,
   * because this one has already been read.
   *
   * The first version drew each item's own MODEL in a thought bubble out in the
   * world. Right instinct, wrong readout: three loaves, three bottles and three
   * jars are three pale shapes half a tile across at this camera, inside the
   * same white sphere — you could see there was something over every unit and
   * not what.
   *
   * `cards` arrive already projected to screen pixels, because only the renderer
   * knows where the camera is and this is the file that owns the DOM. Called
   * every frame while the key is down: the camera rides the player, so a card
   * placed once would slide off the unit it names the moment anybody walked.
   *
   * Which is why the two halves are split by a KEY. Rebuilding thirty cards a
   * frame is thirty `innerHTML` parses of item art sixty times a second; what
   * actually changes per frame is two numbers of `transform`. So the content is
   * written only when a card's own signature moves, and the position always —
   * the same split `setBoardTip` makes one card at a time, for the same reason.
   *
   * ONE CARD PER UNIT, and its boards sit ACROSS it. The hover card is about one
   * heap and the overlay is about a shop, and the difference only shows up once
   * a unit holds more than one thing: a full-size card per board is three cards
   * where the unit is one, so they overlap each other and then the units either
   * side, and the answer to "where does the shop keep this" is buried under the
   * answer for the shelf next door.
   *
   * Which is also why a board is the item's ART and how much of it, and nothing
   * else. The hover card's four fields are the right answer for one heap under
   * a pointer and three of them are noise thirty times over — the name is what
   * the art already says, and the price is a question you ask of one shelf you
   * have decided to look at rather than of a whole shop at a glance. A pair of
   * cells is small enough that three of them side by side are still narrower
   * than one of the old cards.
   *
   * The key is now the fixture id alone, and the signature covers every board —
   * so a delivery landing on board two rewrites that card and no other. Boards
   * are reconciled rather than rebuilt for the same reason the card is: a unit
   * grows and loses boards (a tier, a reservation being ticked), and that is
   * rare, where the frame is not.
   *
   * ...and the same key is what makes DECLUTTERING affordable. Cards land where
   * their units are, and units are three tiles apart on an aisle while a card is
   * wider than that, so grouping cuts how many collide without ending them. A
   * card that is nudged has to be measured first, and `offsetWidth` is a forced
   * layout read — thirty of those a frame is exactly the stutter the key split
   * exists to avoid. So a card's box is measured on the frame its content is
   * written and cached beside it, and the frame's own work is arithmetic on
   * numbers we already have.
   */
  setPeek(cards) {
    const el = this.el.peek;
    if (!el) return;
    this._peek ??= new Map();
    const live = new Set();
    // Every card that is on screen this frame, in the order they arrived. The
    // position is settled over the whole set before any of it is written, or
    // the first card would be placed against boxes that are about to move.
    const order = [];

    for (const c of cards ?? []) {
      live.add(c.key);
      let rec = this._peek.get(c.key);
      if (!rec) {
        const node = document.createElement('div');
        node.className = 'pk-card';
        el.append(node);
        rec = { node, rows: [], sig: null };
        this._peek.set(c.key, rec);
      }
      const rows = c.rows ?? [];
      const sig = rows
        .map((r) => `${r.itemId}:${r.qty}:${r.cap}:${r.want ? 1 : 0}`)
        .join('|');
      if (rec.sig !== sig) {
        rec.sig = sig;
        while (rec.rows.length > rows.length) rec.rows.pop().row.remove();
        while (rec.rows.length < rows.length) rec.rows.push(this.peekRow(rec.node));
        rows.forEach((r, i) => {
          const line = rec.rows[i];
          // The one line in here that parses HTML, which is why it is behind
          // the key and not merely tidied into it.
          line.ico.innerHTML = artForModel(this.itemById(r.itemId)?.model) ?? '';
          // A board that is reserved and EMPTY is what the key is most for, and
          // "0/8" says the wrong thing about it — a zero that is a plan reads as
          // a zero that is a problem. So it says which it is, in words.
          line.count.textContent = r.want ? 'kept for' : (r.cap > 0 ? `${r.qty}/${r.cap}` : `${r.qty}`);
          line.count.classList.toggle('full', !r.want && r.cap > 0 && r.qty >= r.cap);
          line.row.classList.toggle('pk-want', !!r.want);
        });
        // Measured HERE and nowhere else — see the header. A card's size is a
        // fact about its content, so the frame that writes the content is the
        // one frame that has to pay for a layout read.
        rec.w = rec.node.offsetWidth;
        rec.h = rec.node.offsetHeight;
      }
      rec.x = c.x;
      rec.y = c.y;
      order.push(rec);
    }

    this.declutterPeek(order);
    for (const rec of order) {
      rec.node.style.transform =
        `translate(${Math.round(rec.x)}px, ${Math.round(rec.y)}px) translate(-50%, -100%)`;
    }

    for (const [key, rec] of this._peek) {
      if (live.has(key)) continue;
      rec.node.remove();
      this._peek.delete(key);
    }
  }

  /**
   * Move cards off each other, and only ever UP.
   *
   * Grouping a unit's boards into one card is most of the answer — it is what
   * takes a furnished shop from a hundred cards to a dozen — but a card is still
   * wider than the three-tile pitch an aisle stands its units on, so two units
   * side on to the camera still collide. What that costs is not tidiness: a card
   * half under another one reads as belonging to whichever unit is nearest it,
   * which is a readout that is confidently wrong about where the shop keeps
   * something. That is the one thing the key exists to answer.
   *
   * Three rules, and each is doing a job.
   *
   * **Nearest first.** Front-to-back, so the units closest to the camera — the
   * ones you are looking at — keep their exact spot and everything behind them
   * gives way. Sorted the other way the front of the shop is what moves, and
   * what you are reading is the part that drifted.
   *
   * **Up and never sideways.** A card keeps its unit's own screen x, so it stays
   * in the unit's column and the association survives the move; slid sideways it
   * would be a card sitting over its neighbour, which is the bug. Up is also
   * where the room is, since a card is anchored at a unit's top and everything
   * above that is sky.
   *
   * **A settle rather than a solve.** It re-tests against everything already
   * placed after each nudge, because clearing card A can push you into card B,
   * and it gives up after a bounded number of passes: a stack deep enough to
   * spend forty moves is a shop where no arrangement reads anyway, and an
   * unbounded loop here is a frozen tab. It runs on the cached boxes only, so
   * the cost is arithmetic over a dozen cards.
   */
  declutterPeek(list) {
    const GAP = 4;
    list.sort((a, b) => b.y - a.y);
    const placed = [];
    for (const e of list) {
      if (!(e.w > 0) || !(e.h > 0)) { placed.push(e); continue; }
      for (let pass = 0; pass < 40; pass++) {
        let moved = false;
        for (const p of placed) {
          if (!(p.w > 0) || !(p.h > 0)) continue;
          if (Math.abs(e.x - p.x) >= (e.w + p.w) / 2 + GAP) continue;
          if (e.y - e.h >= p.y || p.y - p.h >= e.y) continue;
          e.y = p.y - p.h - GAP;
          moved = true;
        }
        if (!moved) break;
      }
      placed.push(e);
    }
  }

  /**
   * One board inside a peek card: the item's art, and how much of it.
   *
   * A cell of its own rather than two loose spans in the card, because it is
   * what a board is removed BY when a unit loses one, and because "this board is
   * a promise" is a fact about the pair rather than about either half — and it
   * is what the hairline between boards hangs on.
   */
  peekRow(node) {
    const row = document.createElement('div');
    row.className = 'pk-row';
    const ico = document.createElement('span');
    ico.className = 'bt-ico';
    const count = document.createElement('span');
    count.className = 'bt-sub';
    row.append(ico, count);
    node.append(row);
    return { row, ico, count };
  }

  setBoardTip(shelf, itemId, px = 0, py = 0) {
    const el = this.el.boardtip;
    if (!el) return;
    const stack = itemId
      ? (shelf?.stacks ?? []).find((k) => k.item_id === itemId)
      : null;
    if (!stack) {
      // `classList` and never `className`: the string form drops `hud`, and
      // with it `position: fixed` — see `toast` for the four years that cost.
      el.classList.remove('show');
      return;
    }

    // Built once and then written into, rather than re-parsed. This runs off
    // pointermove, which is sixty times a second while you sweep along a
    // shelf — an `innerHTML` here throws a card's worth of DOM away every
    // frame, and text nodes mean nothing has to be escaped on the way in.
    if (!this._tip) {
      const ico = document.createElement('span');
      ico.className = 'bt-ico';
      const name = document.createElement('div');
      name.className = 'bt-name';
      const sub = document.createElement('div');
      sub.className = 'bt-sub';
      const count = document.createElement('span');
      const dot = document.createElement('span');
      dot.className = 'bt-dot';
      dot.textContent = '·';
      const price = document.createElement('span');
      sub.append(count, dot, price);
      const words = document.createElement('div');
      words.append(name, sub);
      el.replaceChildren(ico, words);
      this._tip = { ico, name, count, price, item: null };
    }

    // The item, drawn from its own model — the same art the heap on the shelf
    // is built from, so the card cannot show one thing while the board shows
    // another. Written only when the ITEM changes, not when its count does:
    // this is the one line in here that parses HTML, and the pointer crossing a
    // shelf calls the rest of it sixty times a second.
    if (this._tip.item !== stack.item_id) {
      this._tip.item = stack.item_id;
      this._tip.ico.innerHTML = artForModel(this.itemById(stack.item_id)?.model) ?? '';
    }

    // `cap` rides on the stack itself — the fixture menu's board rows read the
    // same field, so "8/8" here and there can never disagree about what a tier
    // holds.
    const cap = stack.cap ?? 0;
    this._tip.name.textContent = this.itemName(stack.item_id);
    this._tip.count.textContent = cap > 0 ? `${stack.qty}/${cap}` : `${stack.qty}`;
    this._tip.count.className = cap > 0 && stack.qty >= cap ? 'full' : '';
    this._tip.price.textContent = money(stack.price ?? 0);

    // Below and right of the cursor by default, which is where a pointer is
    // not. Measured rather than assumed, because the name is as long as the
    // longest item anybody authors.
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x = px + 16 + w > innerWidth ? px - 16 - w : px + 16;
    const y = py + 14 + h > innerHeight ? py - 14 - h : py + 14;
    el.style.left = `${Math.max(6, x)}px`;
    el.style.top = `${Math.max(6, y)}px`;
    el.classList.add('show');
  }

  // ---- panels --------------------------------------------------------------

  /**
   * WHICH PANEL IS UP — and the one thing that follows from the Menu being it.
   *
   * An accessor rather than a plain field because five places set it and they
   * are in four files (`showSection`, `closePanel`, and the fixture, worker and
   * doorway menus, each of which assigns `ui.openPanel` itself). A hook on each
   * would be four chances to add the next menu and forget, and the failure is
   * silent in the worst direction — a shop left stopped.
   */
  get openPanel() { return this._openPanel ?? null; }

  set openPanel(id) {
    const was = this._openPanel ?? null;
    this._openPanel = id ?? null;
    if (was !== this._openPanel) this.holdForMenu(this._openPanel === 'help');
  }

  /**
   * THE WORLD STOPS WHILE THE MENU IS OPEN.
   *
   * The Menu is the one panel you open to do something to the *game* rather
   * than to the shop — leave it, switch the tour off, look a key up — and every
   * one of those is a thing you do while not playing. Reading the whole Controls
   * tab with the tills running is a queue you lost for a reason that was not the
   * shop's fault. Every other panel is deliberately not this: the supplier, the
   * roster and the shelf menu are all things you do *while* trading, and a shop
   * that froze whenever you ordered stock would be a different game.
   *
   * `menuHeld` is what makes "unless it was already paused" work, and it is a
   * record of OUR OWN press rather than a copy of the state: if the clock was
   * already stopped when the menu went up we never touched it, so closing the
   * menu has nothing to hand back. Pressing P inside the menu still wins — it
   * sets the state directly, and the release below asks for what we asked for
   * rather than for the opposite of whatever is true at the time.
   *
   * It goes through the ordinary `pause` message, so it is the same stop the
   * clock and the P key send: struck-through clock, blinking window edge, the
   * renderer told. That is the honest signal — a world that quietly stopped with
   * nothing on screen to say so is worse than one that says it.
   *
   * ⚠️ It is therefore SHOP-WIDE. A shop is something two people can be in, and
   * pause has always been the whole world rather than one person's view — so a
   * guest opening the Menu stops the host's shop too. That is a consequence of
   * there being one clock, not of this: giving the Menu a hold of its own would
   * mean a second kind of stopped world on the wire.
   */
  holdForMenu(on) {
    if (!this.net) return;
    if (on) {
      // Nothing to hand back if somebody already stopped it. Read now, because
      // by the time the menu closes the mirror is our own pause looking back.
      this.menuHeld = !this.paused;
      if (this.menuHeld) this.setPaused(true, true);
      return;
    }
    if (!this.menuHeld) return;
    this.menuHeld = false;
    this.setPaused(false, true);
  }

  closePanel() {
    this.openPanel = null;
    this.setFixtureRef(null);
    this.setWorkerRef(null);
    // A doorway is not a thing, so this is a lattice line rather than an id —
    // see client/edge-menu.js.
    this.wayRef = null;
    // Whatever per-entity menu was open stops being kept up to date with it.
    this.panelTick = null;
    this._panelPressed = false;
    this.el.panel.classList.remove('show');
    this.el.filter.hidden = true;
    this.clearFilter();
    this.rail.setOpen(null);
    // Order matters: the mode is released once nothing is open, because
    // `toggleBuild` shuts an open fixture menu itself and would re-enter this.
    this.releaseMenuMode();
    // The seed hotbar belongs to the seed menu and leaves with it.
    this.renderHotbar();
  }

  /**
   * One press, one layer. What you typed, then an open menu, then the fixture
   * in your hands, then build mode itself — so Escape never quits building when
   * all you wanted was to clear a search box.
   *
   * **Returns whether it actually backed out of anything**, which is the whole
   * of what lets the right button walk. The bottom of the ladder has always been
   * a no-op — nothing open, not building, nothing to shed — and a press that
   * does nothing is a press the world can have instead. Every rung says so
   * rather than the caller guessing from state it would have to re-read: the
   * ladder is the only thing that knows which rung it was on.
   *
   * `dry` asks the same question without answering it with an action, and it
   * exists for the pill: "the right button goes there" is only true when nothing
   * up here is going to eat the press first, and a hint that promised the walk
   * with a menu open would be the green ghost with words on it. It is this
   * function rather than a second list of the same tests — a copy of a ladder
   * this long is a copy that is wrong within a month, and it would be wrong
   * silently, since both halves look right on their own.
   */
  escape(dry = false) {
    // Every rung is `condition → act → true`, so the dry half is one wrapper
    // rather than a branch per rung: skip the doing, keep the answer.
    const yes = (act) => { if (!dry) act(); return true; };
    // Outermost rung of all: it floats over everything, it owns no world state,
    // and it is the most recent thing you opened whenever it is up.
    if (this.shapesOn) return yes(() => this.toggleShapes(false));
    if (this.openPanel && this.query) return yes(() => { this.clearFilter(); this.repaint(); });
    if (this.openPanel) return yes(() => this.closePanel());
    // A pile you pressed is a selection too, and the lightest one there is: it
    // owns no world state, nothing is armed by it, and it is almost always the
    // last thing you did. Above the fixture rung because it is finer — a board
    // is one pile on a unit, so backing out of it should not also give up the
    // unit. `main.js` registers it; nothing here knows what a board is.
    if (this.dropBoardPick?.(dry)) return true;
    // ...and a copied stamp, which is the same shape and one rung sooner: it is
    // something in your hands rather than something you selected, so it comes
    // off before anything you merely pointed at. `main.js` registers it, the way
    // it registers the board pick, and nothing in here knows what a blueprint is.
    if (this.dropStamp?.(dry)) return true;
    // A selection with no menu over it is its own rung, and it has to be one:
    // it is the only thing on screen at this point, and a teal ring nothing can
    // dismiss is a ring that follows you round the shop. Below the panel rung
    // rather than beside it, because `closePanel` already clears the ref — with
    // a fixture menu up these two are one press, which is what it looks like.
    if (this.fixtureRef) return yes(() => this.setFixtureRef(null));
    // ...and a hire picked out the same way, which needs this rung more than a
    // shelf does: their ring rides on the body (`setPersonSelected`), so one
    // left behind does not merely sit there, it walks off round the shop with
    // somebody. Beside the fixture rather than above it because the two are the
    // same kind of thing, and only one of them is ever set — build mode is the
    // only place a fixture is picked without a menu, and `aimPerson` answers
    // nobody there.
    if (this.workerRef) return yes(() => this.setWorkerRef(null));
    // A browse bar is a rung of its own. It arms nothing and owns no world
    // state, so it comes off before anything that does — and it is the only
    // thing on screen at this point, which is what makes it the next thing out.
    //
    // BOTH of them. This said `'staff'` and the upgrades bar has been the other
    // browse bar since it existed — `renderHotbar` tests for exactly this pair —
    // so backing out of the upgrades strip fell through to the build rungs
    // below, found `buildOn` false, and returned having done nothing at all. A
    // press that does nothing is indistinguishable from one that was not
    // received, which is what "right click doesn't close it" is.
    if (this.bar === 'staff') return yes(() => this.showBar(null));
    if (!this.buildOn) return false;
    if (this.holding) return yes(() => this.net.send('build-cancel', {}));
    // Put down what is armed before leaving the mode. One rung, in the place the
    // ladder's own logic puts it: everything above this is something on screen,
    // and an armed tool is the last thing that is *loaded* before the mode
    // itself. So the first press empties your hand and the second shuts the bar,
    // which is what makes backing out of a mis-armed shelf cost one press rather
    // than a mode you then have to turn back on.
    if (this.toolArmed) return yes(() => this.disarmTool());
    // The palette is its own rung now that it is its own press. One press, one
    // layer: the shelves go away and you are still building, which is where the
    // second press of G put you and is where most of building happens.
    if (this.bar === 'build') return yes(() => this.showBar(null));
    return yes(() => this.toggleBuild(false));
  }

  /**
   * Build mode the menus switched on does not outlive them.
   *
   * This has to fire when *any* panel closes, not just the Build menu's own,
   * because opening Build and then tapping a shelf swaps that menu for the
   * fixture's. Closing that one used to leave you stood in an armed build mode
   * with nothing on screen saying so — you removed a shelf and the next tap
   * built one.
   *
   * `_modeFromMenu` is what keeps `G` sovereign: build mode you turned on
   * yourself is never something a menu closing can take away.
   */
  /**
   * Acting on build mode makes it yours: a menu closing no longer takes it away.
   * Picking a fixture to build, lifting one, and placing one all count.
   */
  commitBuildMode() {
    this._modeFromMenu = false;
    this._modeQuiet = false;
  }

  releaseMenuMode() {
    if (!this._modeFromMenu || !this.buildOn) return;
    // Mid-move. Dropping out now would strand the thing in your hands — and
    // `holding` is a snapshot behind the press, so the lift carries its own flag
    // for the gap in between.
    if (this.holding || this._lifting) return;
    this._modeFromMenu = false;
    // However you were put into it is how you're taken back out: a mode you
    // were never told about shouldn't announce itself on the way out.
    const quiet = this._modeQuiet;
    this._modeQuiet = false;
    this.toggleBuild(false, { quiet });
  }

  /**
   * @param scrollKey what is on screen, for the purpose of keeping your place.
   *
   * A REDRAW IS NOT A NEW PANEL. Every menu here re-renders whole against the
   * snapshot — that is what keeps them honest when the other player changes
   * something — and assigning innerHTML sends the scroller back to the top. So
   * picking the eleventh skin, or nudging a weight on the ninth job, threw you
   * back to the first and you had to find your place again to press it twice.
   *
   * The key is what decides whether your place still means anything, and it is
   * a parameter rather than the title because the title cannot tell. Changing
   * TAB keeps the title and is a different list — restoring 300px into it lands
   * you in the middle of something you have not seen the top of. Filtering is
   * the same. So callers with either say so, and everyone else gets the title,
   * which is exactly right for a menu whose content only ever redraws in place.
   */
  /**
   * WHICH MENU A REMEMBERED POSITION BELONGS TO.
   *
   * Not the same question as "which menu is open", and the difference is a
   * drill-down. `panel-drag.js` files a position per menu so the supplier opens
   * where you left the supplier — right, and it made the item menu a *second*
   * menu with a position of its own: press a row and the window you were
   * reading jumps across the screen to wherever nothing had put it yet, which
   * reads as a new window rather than as the same one going one level in.
   *
   * An item IS the supplier one press deep, so it shares its key: the panel
   * stays exactly where it is, its contents change, and Back changes them back.
   * That is also the answer to "why not two panels" — there is one `#panel` and
   * everything renders into it (see docs/ui-shell.md), a second one would need
   * its own drag, its own z-order and its own answer for a phone, and on a phone
   * the second panel is the whole screen.
   */
  panelPosKey() {
    if (this.openPanel === 'item') return 'stock';
    return this.openPanel ?? null;
  }

  showPanel(title, html, scrollKey = title) {
    // Measured BEFORE the swap, off the old content, and only kept when the key
    // says it is the same list. `scrollerOf` because a paned menu scrolls its
    // middle and a plain one scrolls the body — reading the wrong one is a
    // silent zero, which looks exactly like the bug this fixes.
    const keep = scrollKey === this._panelScrollKey
      ? scrollerOf(this.el.panelBody).scrollTop
      : 0;
    this._panelScrollKey = scrollKey;

    // innerHTML because a fixture menu's title leads with its icon, and an
    // icon is now an inline SVG rather than a character.
    //
    // Written only when it says something DIFFERENT (`setHtml`, client/paint.js).
    // A menu's signature is coarser than its markup — a fixture's carries stock,
    // queues, hands and cash — so a shopper paying two aisles away repaints
    // forty rows that come out byte for byte the same, and a repaint that
    // changes nothing still drops `:hover` off whatever the pointer is on. That
    // is the flicker: the row you are reading blinks in time with the snapshot.
    setHtml(this.el.panelTitle, title);
    const rebuilt = setHtml(this.el.panelBody, html);
    // Whatever the last menu was holding itself at, it is not this one's
    // business (`steadyHeight`). Cleared here rather than there because a
    // fixture's menu and a hire's never go through `paintSection` at all — they
    // would have inherited the upgrade list's height and stood there half empty.
    if (rebuilt) this.el.panelBody.style.minHeight = '';
    // Which of the two layouts this content wants. A menu that declared a
    // middle pane gets three panes — head, scroller, foot — and the body itself
    // stops scrolling; everything else stays one plain scrolling column.
    //
    // Decided here, from what the content actually contains, rather than by
    // every caller remembering to say so. It was `position: sticky` on the head
    // and foot, which pins them correctly and still leaves the *whole panel*
    // the scroller: the scrollbar ran the full height behind both pinned
    // regions, which reads as a bar that has lost track of what it is scrolling.
    this.el.panelBody.classList.toggle('paned', !!this.el.panelBody.querySelector('.pnl-mid'));
    // ...and how wide it wants to be, by the same rule and for the same reason.
    // The Shop report is a picture in two columns and asks for the room; every
    // other menu in here is a list, where a wider panel is a longer line to
    // read and nothing gained. Declared by the CONTENT rather than set by
    // whoever opened it, because a width somebody sets is a width somebody
    // forgets to set back — and the class comes off on the next redraw of any
    // other menu without anybody remembering to take it off.
    this.el.panel.classList.toggle('wide', !!this.el.panelBody.querySelector('.pnl-wide'));
    // ...and whether its rows are columns, by the same rule and for the same
    // reason. A head strip is only true of columns that line up between rows,
    // and two of the supplier's did not — what is on a van hangs off the count,
    // and the one button slot holds `×6`, `Cancel` or `Stock` — so a headed
    // list holds those two open at a width every row agrees on. Read off the
    // strip being there rather than set by whoever drew it, so it comes off on
    // the next menu without anybody remembering to take it off.
    this.el.panelBody.classList.toggle('cols', !!this.el.panelBody.querySelector('.heads'));
    this.el.panel.classList.add('show');
    // After `show`, or the element has no size to clamp a position against.
    restorePos(this.el.panel, this.panelPosKey());
    // ...and after that too, for the same reason: a hidden panel has no
    // scrollable height, so an offset set against it is silently clamped to 0.
    // Over-scrolling clamps itself, so a list that got shorter lands at its new
    // bottom rather than refusing.
    if (keep) scrollerOf(this.el.panelBody).scrollTop = keep;
    // Dragged rather than scrollbarred, and faded at whichever end has more —
    // the same deal the bottom bar's strip gets. After the restore above, since
    // both marks are questions about where it is scrolled to; and on whichever
    // of the two elements is the one that scrolls, or a paned menu wires a body
    // that never moves and fades the list that does at neither end.
    wireScroll(scrollerOf(this.el.panelBody), { axis: 'y' });
    // Only a section has anything to filter. `paintSection` turns it back on
    // straight after; a fixture menu never does, so it can't inherit the
    // supplier's search box.
    this.el.filter.hidden = true;
  }
}
