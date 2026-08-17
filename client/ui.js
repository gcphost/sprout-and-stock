/**
 * HUD and menus.
 *
 * Plain DOM over the canvas — no framework. Everything is driven from the
 * server snapshot, so the UI automatically shows content that was added live
 * without a page reload.
 */

import { variantsOf } from '../shared/model.js';
import { fixtureLabel } from '../shared/pieces.js';
import {
  buildTools, buildGroups, groupOfTool, subOfTool, sectionById, staffGroups, upgradeGroups,
} from './sections.js';
import { renderBar, groupAt, nextGroup, KEYED } from './bar.js';
import { showWorker } from './worker-menu.js';
import { showUpgrade } from './upgrade-menu.js';
import { Rail } from './rail.js';
import { tip } from './tip.js';
import { ICONS } from './icons.js';
import { showFixture } from './fixture-menu.js';
import { wireDrag, restorePos } from './panel-drag.js';
import { artForVariant } from './thumb.js';
import { rciHtml, cashflowHtml } from './hud-meters.js';

/**
 * Tag and label text reaches these panels from the database, which anyone can
 * write to over MCP, so it never goes into innerHTML raw.
 */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

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
      groups.push({ label: r.sep, icon: r.icon, passive: !!r.passive, rows: [] });
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
    this.el = {
      cash: document.getElementById('cash'),
      day: document.getElementById('day'),
      clock: document.getElementById('clock'),
      btnOpen: document.getElementById('btn-open'),
      btnPause: document.getElementById('btn-pause'),
      rep: document.getElementById('rep'),
      mood: document.getElementById('mood'),
      full: document.getElementById('full'),
      season: document.getElementById('season'),
      toast: document.getElementById('toast'),
      log: document.getElementById('log'),
      rci: document.getElementById('rci'),
      flow: document.getElementById('flow'),
      todo: document.getElementById('todo'),
      panel: document.getElementById('panel'),
      panelTitle: document.getElementById('panel-title'),
      panelBody: document.getElementById('panel-body'),
      carry: document.getElementById('carry'),
      build: document.getElementById('build'),
      buildGroups: document.getElementById('build-groups'),
      buildSubs: document.getElementById('build-subs'),
      buildTools: document.getElementById('build-tools'),
      buildShapes: document.getElementById('build-shapes'),
      buildHint: document.getElementById('build-hint'),
      prompt: document.getElementById('prompt'),
      rail: document.getElementById('rail'),
      search: document.getElementById('panel-search'),
      filter: document.getElementById('panel-filter'),
    };
    // Per-section, and wiped when the section closes — a filter you can't see
    // the cause of is worse than no filter at all.
    this.query = '';

    // Once, for the whole HUD. It listens on the document and adopts any
    // `title` it is pointed at, so it belongs to the shell rather than to any
    // one panel — the rail was only the first thing to want it.
    tip.install();

    this.rail = new Rail(this, this.el.rail);
    this.el.btnOpen.onclick = () => this.setOpen(!this.shopOpen);
    this.el.btnPause.onclick = () => this.setPaused(!this.paused);
    // Something in them before the first snapshot lands. `setClock` writes the
    // right pair a tenth of a second later; two empty squares in the meantime
    // read as icons that failed to load rather than as a HUD still filling in.
    this.el.btnOpen.innerHTML = ICONS.open;
    this.el.btnPause.innerHTML = ICONS.pause;
    document.getElementById('search-icon').innerHTML = ICONS.search;
    this.el.search.oninput = () => { this.query = this.el.search.value; this.repaint(); };

    const close = document.getElementById('panel-close');
    close.innerHTML = ICONS.close;
    close.onclick = () => this.closePanel();
    // Grab it by its header. Filed under whichever menu is open when you let
    // go, so each one remembers its own spot — see client/panel-drag.js.
    wireDrag(this.el.panel, this.el.panel.querySelector('header'), () => this.openPanel ?? null);
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
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.escape();
    });
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
    // Build mode owns the bar while it is on, and hands it back to nobody when
    // it goes off — the roster does not come back just because you stopped
    // building, since you never asked for it.
    //
    // Except when a menu borrowed the mode for one action of its own, which is
    // what `quiet` means. Every verb in a fixture's menu is gated on build mode
    // server-side, so pressing Rotate has to switch it on — but you asked to
    // turn a shelf, not to go shopping for shelves, and throwing the build
    // palette up over the menu you are still reading answers a question nobody
    // asked. The mode goes on, the bar stays where you left it.
    if (!quiet) {
      this.bar = on ? 'build' : (this.bar === 'build' ? null : this.bar);
    }
    this.rail.setBar(this.bar);
    document.body.classList.toggle('building', on);
    if (!on && this.openPanel === 'fixture') this.closePanel();
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
    // by the ghost under the pointer and the line above the bar.
    this.toast(on ? 'Build mode' : 'Back to shopkeeping');
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
    const f = move.reopen && move.to ? this.scene?.fixtureAt(move.to.x, move.to.z) : null;
    if (f) showFixture(this, f);
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
    if (t.edge === undefined && !t.paint) {
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
    return t?.edge !== undefined || !!t?.paint;
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
   * Is the palette up — that is, does pointing at the world build something?
   *
   * Build mode is two things wearing one flag: the **permission** the server
   * gates its fixture verbs on, and the **palette** that turns a tap on the
   * floor into a purchase. A menu that borrows the mode for one press of Empty
   * or Rotate needs the first and never asked for the second — which `quiet`
   * already says, by leaving the bar where it was. So the bar is the honest
   * test of whether anything is armed.
   *
   * Without this, pressing Empty armed whatever `buildTool` was last set to —
   * `'shelf'` out of the box, since it has a default and the palette is where
   * you would normally have changed it — and the next tap on bare ground bought
   * a shelf, out of a mode with nothing on screen saying it was on. Then
   * `commitBuildMode` on that tap made the borrowed mode yours, so it also
   * outlived the menu that lent it.
   *
   * Deliberately not `armedEdgeTool`'s test: that one asks what the *server*
   * has been told, which is a different question and must keep its answer.
   */
  get paletteArmed() {
    return this.buildOn && this.bar === 'build';
  }

  groundForTool() {
    if (!this.paletteArmed || this.holding) return undefined;
    const t = buildTools(this).find((x) => x.id === this.toolId());
    if (!t?.paint) return undefined;
    return { kind: t.piece ? t.kind : null, piece: t.piece ?? '' };
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
    this.withBuildMode(() => this.net.send('build-rotate', { id: f.id, dir }));
    return true;
  }

  /**
   * The fixture this menu is open on, live off the layout.
   *
   * By id first and by tile second, because a rotation re-mints the placement:
   * the id is right until the snapshot lands and the tile is right afterwards,
   * and for a decoration the tile is only *nearly* right — it shares one.
   *
   * Null with your hands full: every verb it feeds acts on something standing in
   * the shop, and what you are carrying is not standing anywhere.
   */
  selectedFixture() {
    if (this.openPanel !== 'fixture' || !this.fixtureRef || this.holding) return null;
    return this.scene?.fixtureById(this.fixtureRef.id)
      ?? this.scene?.fixtureAt(this.fixtureRef.x, this.fixtureRef.z)
      ?? null;
  }

  rotateBuild() {
    this.buildRot = (this.buildRot + 1) % 4;
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
    this.el.build.classList.toggle('browse', this.bar === 'staff' || this.bar === 'upgrades');
    // Nothing up: the bar is still in the document and still has a height, so
    // say zero explicitly. Everything above it in the stack is `calc()` off
    // this, and a stale value floats the panel over empty screen.
    // …and a bar that has gone has taken the hint with it, which is the one
    // moment `renderBuildHint` cannot see for itself: it is not called from here,
    // so without this the "Nothing armed" line would still be marked as read the
    // next time build mode opens, and having closed the bar once would be enough
    // to never see it again.
    if (!this.bar) { this.forgetHint(); this.measureBar(true); return; }
    const browse = this.browseGroups();
    if (browse) return this.renderBrowseBar(browse, (it) => this.openBarEntry(it), this.litEntry());
    return this.renderBuildBar();
  }

  /**
   * Press one entry of a browse bar.
   *
   * A person opens their own menu — there is a lot to say about somebody who
   * already works here. A kind of person does not: pressing Hire hires. The
   * ceremony argument `showUpgrade` makes does not carry over, because the tile
   * already says the name and the price and there is nothing else to read.
   */
  openBarEntry(it) {
    if (it.hire) return showWorker(this, it.hire);
    if (it.kind) return this.net.send('hire', { kind: it.kind });
    if (it.upgrade) return showUpgrade(this, it.upgrade);
    return undefined;
  }

  /**
   * Which entry the bar draws as the open one. It follows whatever menu is up
   * rather than a selection this object holds — see `renderBrowseBar` — so it
   * is spelled here exactly the way the entries themselves are spelled in
   * `staffGroups` and `upgradeGroups`.
   */
  litEntry() {
    if (this.openPanel === 'worker') return `hire:${this.workerRef}`;
    if (this.openPanel === 'upgrade') return this.upgradeRef;
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
      items: this.el.buildTools,
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
    if (which !== 'build' && this.buildOn) { this.toggleBuild(false, { quiet: true }); }
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
      return { text: `Carrying a ${this.holding.label.toLowerCase()} — tap a tile to set it down · R turns it · Esc puts it back` };
    }
    // Aiming a bulldozer at something is not looking at it, and the line that
    // says "tap to open it" over a thing a tap would delete is the one piece of
    // copy here that could actually cost somebody a shop.
    if (this.aimed && this.demolishArmed()) {
      return { text: `Tear out the ${this.fixtureName(this.aimed).toLowerCase()} — tap it`, warn: true };
    }
    // Two gestures on one thing, so the line has to name both: a hold picks it
    // up, and a gesture nothing on screen mentions is a gesture nobody finds.
    // Only with the bar up, which is the one place the hold does anything —
    // this same line is what a shopper sees pointing at a shelf.
    if (this.aimed) {
      return {
        text: `${this.fixtureName(this.aimed)} — tap to open it`
          + `${this.paletteArmed ? ' · drag it to move it' : ''}`,
      };
    }
    // Empty hands, which is now where the mode starts. Says so, because a bar
    // with nothing lit and no ghost under the pointer is otherwise
    // indistinguishable from a mode that has stopped working — and it is the one
    // state in build mode with nothing on screen to explain itself.
    // `linger`, because this one is an introduction rather than an answer: it is
    // true for as long as you have not picked anything, which is the whole time
    // you spend rearranging what is already there.
    if (this.paletteArmed && !this.toolArmed) {
      return { text: 'Nothing armed — drag things about, or pick something to build', linger: true };
    }
    const v = this.buildVerdict;
    // A red ghost is a refusal, and the reason is the only thing that turns it
    // from "nothing happened" into "not there".
    if (v && !v.ok) return { text: v.reason, bad: true };
    // An amber ghost means it will land and cost you something. Saying what,
    // before the tap rather than after it, is the whole point of the colour.
    if (v?.warn) return { text: `${v.warn} — tap anyway if you meant it · R rotates`, warn: true };
    return null;
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
  setFixtureRef(f) {
    this.fixtureRef = f;
    this.scene?.setSelectedTarget(f);
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
    if (this.bar === 'upgrades') return upgradeGroups(this);
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

  showSection(id) {
    const sec = sectionById(id);
    if (!sec) return;
    // Coming from a different menu means a clean slate. Coming back to the same
    // one — a live content update, a price change — keeps what you typed.
    // Arriving from somewhere else is a clean slate, and a clean slate is what
    // earns the caret — see `showFilter`.
    if (this.openPanel !== id) {
      this.releaseMenuMode(); this.clearFilter(); this.resetTab();
      this._filterFresh = true;
    }
    this.openPanel = id;
    this.setFixtureRef(null);
    this.workerRef = null;
    this.panelTick = null;
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
    const first = groups.findIndex((g) => !g.passive);
    const at = named >= 0 ? named
      : (this._tabPick || first < 0 || !groups[want].passive) ? want : first;
    this._tab = at;
    this._tabName = groups[at].label;
    return at;
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
      tabs = `<div class="tabs">${groups.map((g, n) => `
        <button class="tab${n === at ? ' on' : ''}" data-tab="${n}" title="${esc(g.label)}"
          aria-label="${esc(g.label)}">${g.icon}</button>`).join('')}</div>`;
      rows = [...groups.lead, ...groups[at].rows];
    } else {
      rows = filterable ? this.applyFilter(all) : all;
    }

    const body = rows.length
      ? rows.map((r, i) => this.rowHtml(r, i)).join('')
      : '<div class="foot">Nothing matches that.</div>';

    // Which section, which tab of it, and what it is filtered to. All three
    // change what the list IS, so all three have to drop your place — a search
    // that kept its offset would leave you scrolled past three results.
    this.showPanel(sec.title, tabs + body + (sec.foot ? `<div class="foot">${sec.foot(this)}</div>` : ''),
      `section:${this.openPanel}:${tabs ? at : ''}:${this.query}`);
    this.showFilter(filterable);
    this.wireRows(rows);
    this.el.panelBody.querySelectorAll('[data-tab]').forEach((el) => {
      el.onclick = () => { this.tab = Number(el.dataset.tab); this.paintSection(); };
    });
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
      // nothing, so headings only survive an unfiltered list.
      if (r.sep) return false;
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
   * `art` wins over `icon` where a row has one — a picture of the thing beats a
   * glyph for its kind, which is the same call the palette makes, and `icon`
   * stays as the fallback for anything nobody has drawn.
   */
  rowHtml(r, i) {
    if (r.sep) return `<div class="sep">${r.sep}</div>`;
    const cls = ['row', 'sec-row'];
    if (r.picked) cls.push('picked');
    if (r.dim) cls.push('owned');
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
  r.heat || r.sub ? `<span class="meta">${r.heat ?? ''}${
    r.sub ? `<span class="tags${r.subWarn ? ' warn' : ''}">${r.sub}</span>` : ''}</span>` : ''}</div>
      ${!stacked && r.right ? `<div class="price">${r.right}</div>` : ''}
      ${r.count ? `<span class="held ${r.countClass ?? ''}">${r.count}</span>` : ''}
      ${r.rule ?? ''}
      ${r.button ? `<button data-btn="${i}">${r.button.label}</button>` : ''}
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

  spareOf(itemId) {
    let n = 0;
    for (const d of this.state?.deliveries ?? []) if (d.item_id === itemId) n += d.qty ?? 0;
    for (const p of this.state?.players ?? []) {
      for (const hands of [p.carry, p.haul]) {
        if (hands?.item_id === itemId) n += hands.qty ?? 0;
      }
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
      out.push({ icon: 'shop', hot: true, text: 'The shop is <b>shut</b> — open up (O)' });
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

  /** Raise or drop the shutters. The server decides; this only asks. */
  setOpen(open) { this.net.send('shop-open', { open: !!open }); }

  /** Stop or start the world. Same shape, same reason — see `shopOpen`. */
  setPaused(paused) { this.net.send('pause', { paused: !!paused }); }

  /**
   * The hour, and the two buttons that are now attached to it.
   *
   * Each button shows what it DOES rather than what is true — a shut door when
   * pressing it would shut the shop — which is the way round every play/pause
   * control in the world already works, and the way round the state is *not*
   * said, since the state is already said twice beside it (the clock struck
   * through, the button gone green). The words are in `title`, so the one place
   * this is ambiguous is the place a tooltip resolves it.
   *
   * The icons are diffed before they are written. `textContent` was safe to set
   * ten times a second; `innerHTML` re-parses an SVG and throws the old node
   * away, and a button whose contents are replaced under the pointer can drop
   * its own `:hover`.
   */
  setClock(state) {
    const hour = state.time * 24;
    const h = Math.floor(hour);
    const m = Math.floor((hour - h) * 60);
    this.el.clock.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

    // The BUTTON is about the shutters and the CLOCK is about whether anybody
    // is being served, and those come apart every night: at 22:00 with the
    // shutters up the clock is struck through and the button still offers to
    // close, because there is nothing for you to do about the hour. Reading one
    // value for both would have the button offer to open a shop that is already
    // open, twelve hours a day.
    this.shopOpen = state.shutters ?? state.isOpen ?? true;
    this.paused = !!state.paused;

    const key = `${!!state.isOpen}|${this.shopOpen}|${this.paused}`;
    if (key === this._clockKey) return;
    this._clockKey = key;

    this.el.clock.classList.toggle('shut', !state.isOpen);
    this.el.clock.classList.toggle('paused', this.paused);

    this.el.btnOpen.innerHTML = this.shopOpen ? ICONS.shut : ICONS.open;
    this.el.btnOpen.title = this.shopOpen ? 'Close the shop (O)' : 'Open the shop (O)';
    this.el.btnOpen.classList.toggle('go', !this.shopOpen);

    this.el.btnPause.innerHTML = this.paused ? ICONS.play : ICONS.pause;
    this.el.btnPause.title = this.paused ? 'Start the clock (P)' : 'Stop the clock (P)';
    this.el.btnPause.classList.toggle('on', this.paused);
  }

  /**
   * The two live gauges under reputation.
   *
   * Mood's amber step is at 0.5 on purpose: that is the same threshold the sim
   * uses to decide a shopper looks annoyed, so the bar changes colour on the
   * tick the first face does. Two readouts of one number that disagreed about
   * when it went bad would be worse than only having one.
   *
   * Room counts *down* to the door closing rather than up from empty, so it
   * reads the same way as the two bars above it — long is good.
   */
  setGauges(state) {
    const mood = state.mood ?? 1;
    this.el.mood.style.width = `${Math.round(mood * 100)}%`;
    this.el.mood.style.background = mood >= 0.5 ? 'var(--good)'
      : mood >= 0.2 ? 'var(--warn)' : 'var(--accent)';

    const room = Math.max(0, Math.min(1, 1 - (state.occupancy ?? 0) / (state.turnAwayAt ?? 1.35)));
    const shut = room <= 0;
    // Out of room, the bar has nothing left to say with length — a 0%-wide bar
    // is just an empty track, and an empty track is what "no data" looks like.
    // So it fills instead and pulses: not a quantity any more, an alarm.
    this.el.full.style.width = shut ? '100%' : `${Math.round(room * 100)}%`;
    this.el.full.style.background = shut ? 'var(--accent)'
      : room >= 0.4 ? 'var(--good)' : 'var(--warn)';
    this.el.full.classList.toggle('shut', shut);
  }

  update(state) {
    // The fixture menu reads stock, queues and hoppers straight out of here.
    this.state = state;
    // Somebody the other player let go while you were watching them. The scene
    // falls back to you on its own, but the flag has to go too or the menu of
    // the next hire you open says Unfollow.
    if (this.follow && !(state.roster ?? []).some((e) => e.id === this.follow)) this.setFollow(null);
    this.el.cash.textContent = `$${state.cash.toFixed(2)}`;
    this.el.day.textContent = `Day ${state.day}`;
    this.el.season.textContent = state.season;
    this.el.rep.style.width = `${Math.round(state.reputation * 100)}%`;
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
    this.el.carry.textContent = me?.haul
      ? `carrying a crate of ${me.haul.qty}x ${this.itemName(me.haul.item_id)} `
        + '— tap where it goes, or hold a square to set it down'
      : me?.carry
        ? `carrying ${me.carry.qty}x ${this.itemName(me.carry.item_id)} `
          + '— tap where it goes, or hold a square to put it down'
        : '';
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
        (state.players ?? []).filter((p) => p.staff).map((p) => [p.hire, p.job, p.carry?.qty, p.pastime]),
        // Who you can afford to take on, on the same terms as the palette.
        this.affordStep(state.cash ?? 0),
      ]);
      if (who !== this._staffKey) { this._staffKey = who; this.renderHotbar(); }
    }

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
      this.el.rci.innerHTML = rciHtml(state.departments);
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
    if (key !== this._todoKey) {
      this._todoKey = key;
      this.el.todo.innerHTML = todo
        .map((t) => `<span class="todo${t.hot ? ' hot' : ''}">${ICONS[t.icon]}${t.text}</span>`)
        .join('');
    }

    // The sections and the plot's seed picker read these when they paint, so
    // keep them fresh — and set them before anything asks a section to redraw.
    this._season = state.season;
    this._cash = state.cash;

    this.rail.update();
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
      const last = state.log[state.log.length - 1];
      if (last.msg !== this._lastLog) {
        this._lastLog = last.msg;
        this.pushLog(last.msg);
      }
    }
  }

  /**
   * "Harvesting…", pinned under the HUD.
   *
   * Standing in range is the whole input, so this is the only warning you get
   * that something is about to happen to the thing you are stood next to. It
   * says what, while the ring says how long you have to walk away.
   */
  updatePrompt(action) {
    const key = action ? `${action.kind}:${action.target}` : null;
    if (key === this._promptKey) return;
    this._promptKey = key;

    if (!action) {
      this.el.prompt.className = 'hud';
      return;
    }
    this.el.prompt.innerHTML = `<b>${action.label}…</b>`;
    // Keep `hud` — it carries position:fixed, and dropping it drops the
    // element out of the overlay and into the document flow, invisible.
    this.el.prompt.className = 'hud show going';
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
  pushLog(msg) {
    const line = document.createElement('div');
    line.textContent = msg;
    this.el.log.prepend(line);
    line._timer = setTimeout(() => {
      line.classList.add('out');
      line._timer = setTimeout(() => line.remove(), 300);
    }, 7000);
    while (this.el.log.children.length > 6) this.dropLogLine(this.el.log.lastChild);
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

  // ---- panels --------------------------------------------------------------

  closePanel() {
    this.openPanel = null;
    this.setFixtureRef(null);
    this.workerRef = null;
    // Whatever per-entity menu was open stops being kept up to date with it.
    this.panelTick = null;
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
   */
  escape() {
    // Outermost rung of all: it floats over everything, it owns no world state,
    // and it is the most recent thing you opened whenever it is up.
    if (this.shapesOn) { this.toggleShapes(false); return; }
    if (this.openPanel && this.query) { this.clearFilter(); this.repaint(); return; }
    if (this.openPanel) { this.closePanel(); return; }
    // The roster bar is a rung of its own. It arms nothing and owns no world
    // state, so it comes off before anything that does — and it is the only
    // thing on screen at this point, which is what makes it the next thing out.
    if (this.bar === 'staff') { this.showBar(null); return; }
    if (!this.buildOn) return;
    if (this.holding) { this.net.send('build-cancel', {}); return; }
    // Put down what is armed before leaving the mode. One rung, in the place the
    // ladder's own logic puts it: everything above this is something on screen,
    // and an armed tool is the last thing that is *loaded* before the mode
    // itself. So the first press empties your hand and the second shuts the bar,
    // which is what makes backing out of a mis-armed shelf cost one press rather
    // than a mode you then have to turn back on.
    if (this.toolArmed) { this.disarmTool(); return; }
    this.toggleBuild(false);
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
    this.el.panelTitle.innerHTML = title;
    this.el.panelBody.innerHTML = html;
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
    this.el.panel.classList.add('show');
    // After `show`, or the element has no size to clamp a position against.
    restorePos(this.el.panel, this.openPanel);
    // ...and after that too, for the same reason: a hidden panel has no
    // scrollable height, so an offset set against it is silently clamped to 0.
    // Over-scrolling clamps itself, so a list that got shorter lands at its new
    // bottom rather than refusing.
    if (keep) scrollerOf(this.el.panelBody).scrollTop = keep;
    // Only a section has anything to filter. `paintSection` turns it back on
    // straight after; a fixture menu never does, so it can't inherit the
    // supplier's search box.
    this.el.filter.hidden = true;
  }
}
