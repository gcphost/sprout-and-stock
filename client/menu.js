/**
 * THE FRONT DOOR — pick a shop, or start a new one.
 *
 * It is a `#panel`, and that is the whole of the design. It used to be its own
 * look — a column of cards standing on a sky, each with a contour, a side and a
 * hard offset shadow — and what dated it is that the HUD moved and it did not:
 * cream paper, one ranked contour drawn as an overlay, creases inside, no
 * radius, no drop shadows. So there is one card here now, every hairline in it
 * is a crease, and not a colour, a radius or a typeface in it was chosen — they
 * are the token block in client/index.html, applied to a screen that had been
 * answering the same questions in its own words.
 *
 * `docs/ui-shell.md` says anything that lists or offers actions goes in
 * `#panel`, because a second floating div over the world goes stale, survives
 * re-flows it shouldn't and eats the Escape key. None of that applies here:
 * there is no world yet. The panel system draws over a running game and reads
 * from a snapshot; this draws before there is a socket, and reads from HTTP.
 * What it borrows is the LOOK, and nothing else.
 *
 * It resolves with the world you chose, and `main.js` connects to that. Nothing
 * else in the client knows there is more than one shop.
 */

import { money } from './money.js';
import { START_TIERS, DEFAULT_TIER, startTier, tierById } from '../shared/start.js';
import { DIFFICULTIES, NEW_DIFFICULTY, difficultyById } from '../shared/difficulty.js';
import { SURROUNDS, DEFAULT_SURROUND } from '../shared/surrounds.js';
import { defaultPiece } from '../shared/pieces.js';
import { artForPiece } from './thumb.js';
import { shopfrontArt, planArt } from './frontart.js';
import { markWorldNew } from './tutor.js';
import { mix } from './audio/mix.js';
import { music } from './audio/music.js';
import { loadCrew } from './greeter.js';
import { api } from './front-api.js';
import { bootHide } from './boot.js';
import { wireScroll } from './scroll.js';
import { SUPPORT_URL, SUPPORT_LABEL } from './links.js';
import { ICONS } from './icons.js';

export { setMenuApi } from './front-api.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/**
 * NOTHING IS TYPED ON THIS SCREEN, which retired more than two fields.
 *
 * There were two text boxes — your name and the shop's — and both were a
 * keyboard standing between somebody and the game. Neither was load-bearing:
 * `whoAmI` (client/net.js) mints the id this browser is known by without ever
 * being told a name, and `createWorld` already calls a shop `Shop N` when
 * nobody says otherwise, which is what every save in the list is called anyway.
 * Rename it in the shop, where there is a keyboard out and you know what you
 * are naming.
 *
 * What went with them is worth knowing, because each was a real fix for a real
 * problem that only existed because there was a field here at all:
 *
 * - **`NO_FILL`**, five vendor opt-out attributes, because a lone text box
 *   labelled "You are" on a title screen is a username box to a password
 *   manager's heuristics — so the front door grew an icon, an offer to fill and
 *   on some of them a dropdown over the button underneath.
 * - **`caret`**, which focused the shop-name box on a keyboard and deliberately
 *   did not on a phone, where focus raises half a screen of keyboard over the
 *   form you have not read yet.
 * - **The read-before-`act` rule in `create`**, which is why that method is now
 *   three lines: `render` rebuilt the box from `innerHTML` to show "Working…",
 *   so a field read inside the callback arrived at the server as "".
 *
 * All three are gone rather than kept "in case". Anything typed on this screen
 * brings the whole list back with it.
 */

/**
 * The five things a starting kit is counted in, and the word for each.
 *
 * A WORD AND NOT THE ROW'S NAME, which is worth stating because the picture
 * beside it IS the row's: a tile is about 74px, so it wants "racks" where the
 * catalog says "Grow Rack", and it needs a plural, which a name has no idea
 * how to make. What it must never do is disagree — a bed is a `plot` in the
 * code for the reason CLAUDE.md gives about every other old spelling, and it
 * has not been a bed in the game since the farm came indoors (docs/vats.md).
 * Same for the pen, which is a vat.
 */
const KIT = [
  { kind: 'shelf', one: 'shelf', many: 'shelves' },
  { kind: 'freezer', one: 'freezer', many: 'freezers' },
  { kind: 'checkout', one: 'till', many: 'tills' },
  { kind: 'plot', one: 'rack', many: 'racks' },
  { kind: 'pen', one: 'vat', many: 'vats' },
];

/**
 * The build catalog, for the pictures in the new-shop form.
 *
 * The fifth thing this screen asks for over HTTP, and added on purpose the way
 * `client/worker.js` says a fifth should be. Off the content API rather than
 * the game's catalog for the reason `loadCrew` gives about the worker kinds:
 * neither screen that wants art has a socket yet.
 *
 * Module-level and fetched once, so the form repainting as you change a
 * dropdown is not a request. Not remembered in localStorage the way the crew is
 * — the crew is there to cover a loading screen that is up for less time than a
 * fetch, and this is drawn *after* one.
 */
let pieces = null;
let piecesPending = null;

async function loadPieces() {
  if (pieces) return pieces;
  piecesPending ??= api('GET', '/content/fixture')
    .then((got) => got?.rows ?? [])
    .catch(() => []);
  pieces = await piecesPending;
  return pieces;
}

/**
 * What a tier comes with, as the things themselves — and what it comes with
 * FIRST is the money.
 *
 * The cash had a row of its own under the tiles, which made it a footnote to
 * the list rather than the first thing in it. What a size hands you is money
 * and then things, in that order, so it is the first chip: same box, the figure
 * standing where the art stands, in `--accent`, which is what a number that
 * matters wears everywhere else in this chrome.
 *
 * The art is `defaultPiece` → `artForPiece` — the same two calls a fixture
 * standing in the shop is drawn through, so the form cannot promise a cooler
 * the shop opens without and no second picture of a shelf has to be kept
 * matching the first. That is `client/thumb.js`'s whole rule, said about a form
 * rather than about a palette button.
 *
 * A kind with no art draws its number and its word and nothing else, which is
 * the same answer the front door already gives a build with no worker art
 * authored: a grey silhouette is worse than a gap.
 */
function kitTiles(t) {
  const cash = `<div class="kitem kmoney">
      <b>${money(t.cash)}</b><span><em>to start</em></span>
    </div>`;
  return cash + KIT.map(({ kind, one, many }) => {
    const n = t.fixtures[kind] ?? 0;
    if (!n) return '';
    const art = artForPiece(defaultPiece(pieces, kind), kind);
    return `<div class="kitem">
        <div class="kart">${art ?? ''}</div>
        <span>&times;${n} <em>${n === 1 ? one : many}</em></span>
      </div>`;
  }).join('');
}

/** "3 days ago" beats a timestamp when the question is "which one was I in". */
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60;
  if (m < 90) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

const REMEMBERED = 'sns-world';

/**
 * THE CHIPS, and why each one has a picture on it.
 *
 * Every shop is called `Shop N`, so the three things you picked when you made
 * it are the only thing that tells one save from another before you open it —
 * which makes them identity rather than detail, and puts them on the row.
 *
 * They were a sentence with middots in it, which is a list pretending to be a
 * line of text: flat by construction, because every word in it is the same size
 * and weight as every other. As chips they are three objects you can count at a
 * glance, and the glyph is what lets a chip be shorter than the words it
 * replaced — an awning that widens with the size, a three-bar gauge for how
 * hard the town is, and a tree, a house or a tower for where it stands. You
 * read the shape before you read the word.
 *
 * Drawn here rather than fetched, and that is the one place this file breaks
 * `thumb.js`'s rule on purpose: these are not pictures of a fixture the shop
 * draws, they are marks for three tables that have no art at all. `currentColor`
 * throughout, so a chip that takes a colour takes its glyph with it.
 */
const CHIP_GLYPH = {
  corner: '<svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><rect x="2.2" y="3" width="4.6" height="5.4" fill="currentColor"/><path d="M1 3.2 4.5 1 8 3.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  mini: '<svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><rect x="1.2" y="3" width="6.6" height="5.4" fill="currentColor"/><path d="M.2 3.2 4.5 1 8.8 3.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  super: '<svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><rect x=".4" y="2.6" width="8.2" height="5.8" fill="currentColor"/><path d="M0 2.8 4.5.4 9 2.8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  relaxed: '<svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><rect x=".6" y="6" width="2" height="2.4" fill="currentColor"/><rect x="3.5" y="6" width="2" height="2.4" fill="currentColor" opacity=".35"/><rect x="6.4" y="6" width="2" height="2.4" fill="currentColor" opacity=".35"/></svg>',
  normal: '<svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><rect x=".6" y="6" width="2" height="2.4" fill="currentColor"/><rect x="3.5" y="4.2" width="2" height="4.2" fill="currentColor"/><rect x="6.4" y="6" width="2" height="2.4" fill="currentColor" opacity=".35"/></svg>',
  hard: '<svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><rect x=".6" y="6" width="2" height="2.4" fill="currentColor"/><rect x="3.5" y="4.2" width="2" height="4.2" fill="currentColor"/><rect x="6.4" y="2" width="2" height="6.4" fill="currentColor"/></svg>',
  country: '<svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><circle cx="4.5" cy="3.4" r="2.8" fill="currentColor"/><rect x="3.9" y="5.6" width="1.3" height="3" fill="currentColor"/></svg>',
  suburb: '<svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><path d="M.6 4 4.5.8 8.4 4v4.4H.6Z" fill="currentColor"/></svg>',
  city: '<svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><rect x=".6" y="2.4" width="3" height="6" fill="currentColor"/><rect x="4.6" y=".6" width="3.8" height="7.8" fill="currentColor" opacity=".6"/></svg>',
};

const chip = (id, label, cls = '') => (label
  ? `<span class="tg${cls ? ` ${cls}` : ''}">${CHIP_GLYPH[id] ?? ''}${esc(label)}</span>`
  : '');

/**
 * THE THREE DECISIONS, AS THREE DROPDOWNS ON ONE ROW.
 *
 * Nine buttons became three, and what you read across the form is the shop you
 * are about to get — "Corner shop, Normal, Countryside" — rather than nine
 * options of which six are off. It also gives each option somewhere to put its
 * own blurb: both of these tables carry one, and a row of buttons could only
 * ever hang it on a `title`, which is a sentence nobody on a phone will ever
 * see.
 *
 * `blurb` is the field, not the wording: `SURROUNDS` spells its own `sub`, and
 * the table is the one place any of this is written down. See shared/start.js,
 * shared/difficulty.js and shared/surrounds.js.
 */
const DROPS = [
  { key: 'tier', rows: START_TIERS, blurb: (o) => o.blurb },
  { key: 'difficulty', rows: DIFFICULTIES, blurb: (o) => o.blurb },
  { key: 'surround', rows: SURROUNDS, blurb: (o) => o.sub },
];

/** The caret: a well sunk into the face with a solid triangle in it. */
const CARET = '<span class="caret" aria-hidden="true"><svg width="9" height="7" '
  + 'viewBox="0 0 9 7"><path d="M.6 1.2h7.8L4.5 6.4Z" fill="currentColor"/></svg></span>';

/**
 * A NEW SHOP IS NOT ENTERED IN BUILD MODE, WHATEVER THE LAST ONE WAS.
 *
 * `restoreView` in client/main.js keeps how you like the camera in `sns-view` —
 * pitch, yaw, and whether you were building — and that key is the one that is
 * deliberately NOT per-world, on the argument that all three are facts about
 * the person rather than about the shop. The first two still are. The third
 * stopped being one the day a tap in build mode took the VIEW there instead of
 * your feet (`building()` in `tapAtPointer`), because the keys had already gone
 * the same way (`flying()`): with the palette up there is no gesture left in the
 * game that moves your body at all.
 *
 * So a shop you made ten seconds ago opened with its player parked, because of
 * a mode you switched on in a different shop, and the tour's second card —
 * "click the marked tile, you walk to it" — could not be finished by any press
 * on the machine. Nothing on screen connects the two.
 *
 * Cleared HERE, at the moment of creation, rather than gated in `restoreView`,
 * and both halves of that matter. It is the fact this press knows and nothing
 * downstream does — "was this shop just made" is exactly `markWorldNew`'s
 * question, asked one line below. And a gate would have to hold that fact
 * somewhere until the first frame, which is a second list to leak: the tour's
 * own new-world mark is only cleared when the tour ENDS, so a player with
 * tutorials switched off would leave a world marked new for ever and never get
 * their mode back in it.
 *
 * The per-world half goes too, and that is not tidiness. `mintId` frees the id
 * of a deleted shop — make another one with the same name and you get the same
 * string back — so a brand new save can inherit the camera position of the shop
 * you just binned. Same trap `markWorldNew` documents about the tour's own
 * marks, and it is why the first attempt at this fix, which read "has this
 * world got a stored centre" as "have I ever played this world", did nothing at
 * all for anybody who reuses a shop name.
 *
 * Keys spelled out rather than imported: client/main.js owns them, and it
 * imports this file. Anything added to `sns-view` that is per-shop belongs in
 * this function too.
 */
function forgetViewFor(id) {
  try {
    const raw = JSON.parse(localStorage.getItem('sns-view') ?? 'null');
    if (raw && raw.build) {
      delete raw.build;
      localStorage.setItem('sns-view', JSON.stringify(raw));
    }
    if (id) localStorage.removeItem(`sns-view-at:${id}`);
  } catch { /* private mode, quota, a stale value — none of it worth a toast */ }
}

/**
 * Whether this build can be a guest in somebody else's shop.
 *
 * Only the web build: joining means a data channel to a browser that is running
 * the shop, and in the server build the shop is on a server both people can
 * simply open a URL to. Set by `main.js`, which is the one place that knows
 * which transport it has — and it knows it as a *capability* rather than a flag.
 */
let JOIN_ENABLED = false;

export function enableJoin(on = true) { JOIN_ENABLED = on; }

/**
 * How long "press it again to delete" stays armed.
 *
 * Same latch the worker menu uses for letting someone go, and for the same
 * reason: the ✕ sits on a row that is itself the Play button, and nothing comes
 * back. A modal would ask harder, but it asks *somewhere else* — you read a
 * dialog about a name instead of looking at the shop you meant to keep.
 */
const DELETE_ARM_MS = 4000;

export class Menu {
  /**
   * `error` is for what went wrong *before* the menu opened — a link to a shop
   * that has since been deleted, most often. Landing on a bare list with no
   * explanation reads as the game having forgotten, rather than as the shop
   * having gone.
   */
  constructor(root, notice = null) {
    this.root = root;
    this.worlds = [];
    this.busy = false;
    // Two channels on purpose. `error` is this menu's own last failure and is
    // cleared by the next successful load; `notice` is what went wrong before
    // the menu existed and has to survive that load, or the reason the list is
    // in front of you is gone by the time you read it.
    this.notice = notice;
    this.error = null;
    this.creating = false;
    // Which size of shop the new-shop form is offering. Held on the menu rather
    // than read off the DOM, because the form repaints in place as you change
    // it and a value living in a `.on` class somewhere is a value that goes
    // with the next repaint.
    this.tier = DEFAULT_TIER;
    // The *creation* default, which is deliberately not the one a save with
    // nothing to say reads as — see shared/difficulty.js. The form offering
    // `relaxed` would quietly make the gentle game the one everybody keeps
    // getting, which is the thing this whole preset exists to stop.
    this.difficulty = NEW_DIFFICULTY;
    // ...and where the shop stands, held here for the same reason and defaulting
    // the same way a save with nothing to say reads — see shared/surrounds.js.
    // Unlike the two above it, this one used to be a row in the in-game Menu:
    // it is a fact about the save rather than about the person, so it belongs
    // to the shop, and the moment a shop is a thing you *make* the honest place
    // to ask is the form that makes one. Which also retires the awkward half of
    // the old row — a picture you could change on somebody else's screen while
    // they were standing in it.
    this.surround = DEFAULT_SURROUND;
    // Which of the three lists is showing, by key. One at a time: three open
    // lists over one another is a form with no answer visible in it.
    this.openDrop = null;
    // `{ id, at }` for the one shop whose Delete is armed. By id, not by index:
    // a refresh re-sorts the list, and an armed row number would end up over
    // somebody else's shop.
    this.arm = null;
    this.armTimer = null;
    /**
     * Whether this screen's radio has been hushed.
     *
     * Held here rather than read back off `music.held.menu` for the reason
     * `tier` is held here: `render` rebuilds the box from `innerHTML`, so the
     * button is a brand new element on every repaint and needs something to ask.
     *
     * In memory and NOT in localStorage, deliberately. Every other audio
     * preference in the game is remembered because it is a fact about the person
     * and the room they are sitting in; this one is a fact about a screen you
     * are looking at for about twenty seconds, and a front door that came back
     * silent tomorrow would be a fourth place the music can be off with nothing
     * on screen to say which one is doing it.
     */
    this.hushed = false;
    this.rootWired = false;
  }

  /**
   * Show the menu and resolve once a world is picked.
   *
   * Resolves rather than returning immediately because everything after it —
   * the socket, the scene, the render loop — is waiting on the answer, and a
   * menu that resolved early would have `buildWorld` running against a layout
   * from a shop nobody chose.
   */
  choose() {
    this.root.hidden = false;
    this.wireRoot();
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.refresh();
    });
  }

  async refresh() {
    try {
      // `?plans=1` is the floor plan per save, which is what a row's square is
      // drawn from — see `planOf` in server/worlds.js. Asked for by name because
      // the same endpoint is `list_worlds`, and a picture is the one thing an
      // agent reading that answer has no use for.
      const { worlds } = await api('GET', '/worlds?plans=1');
      this.worlds = worlds;
      // A list of nothing is not a choice, so the form is what this screen IS
      // on a first run: opening on an empty list and a button that says "+ New
      // shop" is one press spent on the only thing there is to do. Here rather
      // than in the constructor because it is a fact about the answer, not
      // about the screen — and it comes back if you delete your last shop,
      // which is the same first run wearing a later day. Cancel still shuts it
      // (that redraws without refetching), so it is a default and not a latch.
      if (!this.worlds.length) this.creating = true;
      // The crew, and NOT for this screen: the turntable that used to stand
      // over the title is the art band now. `loadCrew` is what leaves a bot in
      // localStorage for the LOADING screen, which is drawn before any module
      // has run and therefore cannot fetch one of its own — see client/boot.js.
      // Drop this line and the loader silently loses its robot, one visit later,
      // on a screen nobody is looking at while it happens.
      await loadCrew(api);
      // Before the paint rather than after it: the kit tiles are drawn from
      // these rows, and art that lands a tick late is a form that reflows under
      // somebody reading it. Both are one fetch for the life of the page.
      await loadPieces();
      this.error = null;
    } catch (err) {
      this.error = `Can't reach the shop: ${err.message}`;
    }
    this.render();
  }

  /** What the art band is a picture OF, which is the two picks that are a look. */
  picks() {
    if (this.creating) return { tier: this.tier, surround: this.surround };
    // Otherwise the shop you were in last, which is the head of the list: the
    // rows come back most-recently-played first. A front door that is a picture
    // of YOUR shop beats one that is a picture of a shop.
    const last = this.worlds[0] ?? {};
    return { tier: last.tier, surround: last.surround };
  }

  get name() {
    // Whatever was last typed into a name box, from back when there was one.
    // `whoAmI` (client/net.js) is what actually identifies this browser, so this
    // is a label on a body and nothing depends on it being set.
    return localStorage.getItem('sns-name') ?? '';
  }

  // ---- actions ------------------------------------------------------------

  /** Is this shop's Delete armed, and has that not timed out? */
  armed(world) {
    if (!this.arm || this.arm.id !== world.id) return false;
    if (Date.now() - this.arm.at > DELETE_ARM_MS) { this.disarm(); return false; }
    return true;
  }

  disarm(redraw = false) {
    clearTimeout(this.armTimer);
    this.armTimer = null;
    this.arm = null;
    if (redraw) this.render();
  }

  async act(fn) {
    if (this.busy) return;
    // Arming a delete and then pressing something else is not a confirmation.
    this.disarm();
    this.busy = true;
    this.render();
    try {
      await fn();
      this.error = null;
    } catch (err) {
      this.error = err.message;
    }
    this.busy = false;
    await this.refresh();
  }

  play(world) {
    // Or the latch fires four seconds into the game and redraws a hidden menu.
    this.disarm();
    /**
     * ...and the front door lets go of the radio on the way out.
     *
     * This line is the whole of "the menu's mute does not follow you into the
     * shop". Without it the hold is simply a differently-spelled global mute:
     * the screen goes, the holder stays set for the life of the page, and the
     * game plays with the music off for a reason nothing can be pointed at —
     * which is the bug this replaced, wearing the fix's clothes.
     *
     * Unconditional rather than `if (this.hushed)`, because releasing a hold
     * nobody set costs nothing and this must not depend on a flag staying in
     * step with the thing it describes.
     */
    music.hold('menu', false);
    localStorage.setItem(REMEMBERED, world.id);
    this.root.hidden = true;
    // The front door is done, and from here it may not touch the loading
    // screen — see `render`. A flag rather than nulling `resolve`, because what
    // this is a fact about is the SCREEN having been handed over, and a menu
    // that is still finishing an `act` behind it goes on redrawing itself
    // perfectly legitimately.
    this.handedOver = true;
    this.resolve?.({ worldId: world.id, name: this.name, world });
  }

  /**
   * Switch one of the three picks, and repaint what depends on it.
   *
   * In place rather than through `render`, and the reason survives the fields
   * having gone: `render` rebuilds the box from `innerHTML`, so a redraw here
   * would throw the list's scroll position away and rebuild eight save rows and
   * their eight floor plans to change one word. Three things depend on the
   * choice and all three are moved by hand — the buttons, the starting kit, and
   * the picture at the top, which is the whole reason these two questions are
   * worth asking with a picture on screen at all.
   */
  pick(key, value) {
    if (!['tier', 'difficulty', 'surround'].includes(key)) return;
    this[key] = value;
    this.openDrop = null;
    this.repaintForm();
  }

  repaintForm() {
    const drops = this.root.querySelector('.menu-drops');
    if (drops) drops.innerHTML = this.dropsInner();
    const kit = this.root.querySelector('.kitrow');
    if (kit) kit.innerHTML = kitTiles(startTier(this.tier));
    const art = this.root.querySelector('.menu-art');
    // `outerHTML`, because the band IS the `<svg>` — and it carries no listener,
    // which is what makes replacing the element rather than its contents safe.
    if (art) art.outerHTML = shopfrontArt(this.picks());
  }

  /**
   * Making a shop drops you straight into it.
   *
   * The alternative — create, then find it in the list, then press Play — is
   * two extra decisions after you already said what you wanted, and the list is
   * sorted by last played, so a brand new world is not where you are looking.
   *
   * Three fields, and the two that are not sent are the point. `createWorld`
   * names an unnamed shop `Shop N` by counting the rows, and takes the tier's
   * own cash when nobody says otherwise — so omitting both is not a gap, it is
   * the server being the one thing that knows how many shops there are. A name
   * minted here would be a second opinion about it, and two tabs would mint the
   * same one.
   */
  async create() {
    await this.act(async () => {
      const { world } = await api('POST', '/worlds', {
        tier: this.tier,
        difficulty: this.difficulty,
        surround: this.surround,
      });
      // This browser made this shop, so this browser is the one that owes
      // somebody a tour of it. Marked HERE and not inferred from `day === 1`
      // once the game is up: that is also true of a shop somebody made
      // yesterday, closed on the first morning and came back to — and being
      // handed the tour again on a shop you have already furnished is the thing
      // that makes people switch tutorials off. See client/tutor.js.
      markWorldNew(world.id);
      // ...and it does not inherit the mode, or the camera, of whatever you
      // were last doing somewhere else. See `forgetViewFor`.
      forgetViewFor(world.id);
      this.play(world);
    });
  }

  /**
   * Deleting asks first, and asks on the row rather than in a dialog.
   *
   * It is the only way a shop ever disappears — nothing expires a save — and
   * the ✕ stands on the row that IS the Play button. So the first press only
   * arms it: the row says what a second one does, the shop you are about to
   * lose is still in front of you with its day, its money and its own floor
   * plan on it, and the ✕ goes red and stays put. A `confirm()` had to reprint
   * all of that, badly, and by name.
   *
   * Which is why arming may not resize anything. The warning takes over the
   * chips' own cell (`.wswap`, index.html), so the row is exactly as tall armed
   * as not — growing it moved every row below it, and the row you were aiming
   * at, under a cursor that had just been told to press again.
   */
  async remove(world) {
    if (!this.armed(world)) {
      clearTimeout(this.armTimer);
      this.arm = { id: world.id, at: Date.now() };
      // Nothing here ticks, so the latch has to expire itself or the row sits
      // saying "press again" long after pressing again has stopped deleting.
      this.armTimer = setTimeout(() => this.disarm(true), DELETE_ARM_MS);
      this.render();
      return;
    }
    await this.act(() => api('DELETE', `/worlds/${encodeURIComponent(world.id)}`));
  }

  // ---- drawing ------------------------------------------------------------

  /**
   * ONE SAVE, AS A ROW.
   *
   * It was a bordered card inside a bordered box, which is the one thing
   * `#panel`'s own note rules out: a line eight pixels inside another line is
   * two boxes rather than a thing on a thing. So the saves are rows of one
   * card, divided by creases, and the ROW IS THE BUTTON — Play was a slab per
   * save, eight of them down a list, every one saying the thing the row already
   * said.
   *
   * Three things about the shape are load-bearing and invisible.
   *
   * The ✕ is a SIBLING of the row rather than a child of it. A button inside a
   * button is invalid and browsers do their own thing with it, and the two-press
   * delete has to stay a real button — reachable by keyboard, with its own
   * label — rather than a span the row's own handler sniffs for.
   *
   * `Open` is a band across the foot of the picture and not a badge on the name
   * line. Beside the name it was a second object on the one line that should
   * hold one thing, and because it is there on some saves and not others,
   * everything after it started at a different x on every row.
   *
   * `.when` and the ✕ share ONE anchor, the row's own top-right corner. In flow
   * they were pushed along by the name and the badge, so "just now" and "61 min
   * ago" sat at two different x on two rows of one list.
   */
  row(w, i) {
    const last = localStorage.getItem(REMEMBERED) === w.id;
    const arm = this.armed(w);
    const live = w.live
      ? `<span class="live">${w.players ? `${w.players} here` : 'Open'}</span>`
      : '';
    return `
      <div class="shop-row${last ? ' last' : ''}${arm ? ' arm' : ''}">
        <button class="shop" type="button" data-play="${i}">
          <span class="th">${planArt(w.plan)}${live}</span>
          <span class="col">
            <span class="nm">${esc(w.name)}</span>
            <span class="cash">${money(w.cash)}<em>Day ${w.day}</em></span>
            <span class="wswap${arm ? ' on' : ''}">
              <span class="tags">
                ${chip(w.tier, tierById(w.tier)?.name)}
                ${chip(w.difficulty, difficultyById(w.difficulty)?.name,
    w.difficulty === 'hard' ? 'hard' : '')}
                ${chip(w.surround, SURROUNDS.find((s) => s.id === w.surround)?.name)}
              </span>
              <span class="warn">Press &times; again and this shop is gone.</span>
            </span>
          </span>
        </button>
        <span class="when">${ago(w.played_at)}</span>
        <button class="x" type="button" data-del="${i}"
          aria-label="Delete ${esc(w.name)}" title="Delete this shop">&times;</button>
      </div>`;
  }

  /** The three lists, drawn from their own tables. */
  dropsInner() {
    return DROPS.map(({ key, rows, blurb }) => {
      const cur = rows.find((o) => o.id === this[key]) ?? rows[0];
      const open = this.openDrop === key;
      return `<div class="drop${open ? ' open' : ''}">
          <button class="dbtn" type="button" data-drop-open="${key}"
            aria-expanded="${open}">
            <span class="lab">${esc(cur.name)}</span>${CARET}
          </button>
          <div class="dlist">
            ${rows.map((o) => `
              <button class="dopt${o.id === cur.id ? ' on' : ''}" type="button"
                data-drop-key="${key}" data-drop-val="${o.id}">
                <b>${esc(o.name)}</b><i>${esc(blurb(o))}</i>
              </button>`).join('')}
          </div>
        </div>`;
    }).join('');
  }

  form() {
    return `
      <div class="menu-form">
        <div class="menu-drops">${this.dropsInner()}</div>
        <div class="kit"><div class="kitrow">${kitTiles(startTier(this.tier))}</div></div>
        <!-- NO JOIN IN HERE. It lives on the row you got here from, one press
             away behind Cancel — and a third button under a decision you are
             part way through is an exit sitting where the answer goes. -->
        <div class="menu-row">
          <button class="menu-btn go" id="menu-create" type="button">Start it</button>
          <button class="menu-btn" id="menu-cancel" type="button">Cancel</button>
        </div>
      </div>`;
  }

  render() {
    // The loading screen steps aside HERE rather than when the menu is
    // unhidden, and the gap between the two is a fetch. Both screens draw the
    // same ground (`.outdoors`), so they cannot both be up, and hiding the
    // loader at `choose()` would leave a bare field for as long as `/worlds`
    // takes — which is precisely the wait the loader exists for.
    //
    // ...but ONLY while this menu is still the thing on screen, and that clause
    // is not tidiness. It was unconditional on the argument that "after the
    // shop opens the element is gone" — true for as long as `bootDone` ran the
    // moment the socket joined, and false the day the reveal started waiting
    // for a shop to reveal (see `stepReveal`, client/main.js). What made it
    // visible is that `create` goes through `act`, which refreshes the list
    // AFTER the world it just made has been handed over: so making a shop said
    // "Opening the shop…", and twenty milliseconds later a menu nobody can see
    // pulled the loader off a shop that did not exist yet. Loading an existing
    // save was fine throughout, because `play` is called straight off the row
    // and nothing re-renders behind it — which is exactly the shape of a bug
    // that reads as "new worlds are broken and old ones are not".
    if (!this.handedOver) bootHide();
    // The LIST is the scroll container, and it is inside the thing being
    // rebuilt — so emptying `root` collapses it and the browser pins it to 0.
    // With eight shops that reads as the menu jumping to the top every time you
    // arm or delete one, and the row you pressed leaves the screen.
    const scroll = this.root.querySelector('.menu-list')?.scrollTop ?? 0;
    this.root.innerHTML = `
      <div class="menu-box">
        <!-- The one thing on this screen no in-game panel has, and the only
             place the front door says what the game IS rather than which save
             you want. It answers to the two picks that are a picture — see
             the picks method above, and client/frontart.js. Note that a
             backtick anywhere in this comment would end the template literal it
             is written inside, which is why there is not one in it. -->
        ${shopfrontArt(this.picks())}

        <!-- THE WORDMARK STOPPED BEING A TRICK. It wore a 6px cream keyline and
             a drop shadow because it stood on a blue sky and had to be cut out
             of it; on paper it is just a word. It is beside the tagline rather
             than over it because the header is one band now, and centred rather
             than baselined — the tagline wraps and the wordmark does not, so a
             shared baseline hangs the second line below the logo. -->
        <div class="menu-head">
          <h1>Sprocket <span>&amp;</span> Stock</h1>
          <p class="menu-tag">Run a shop with a crew of robots</p>
        </div>

        <div class="menu-top">
          ${this.notice ? `<div class="menu-err soft">${esc(this.notice)}</div>` : ''}
          ${this.error ? `<div class="menu-err">${esc(this.error)}</div>` : ''}
          <!-- Starting one comes BEFORE the list of them, and the form takes the
               button's place rather than opening under it. Both are the same
               point: what you came here to do is at the top either way, and a
               list that grows by one every time you play does not push it
               further down the page each time.
               New shop and Join share a row, two thirds to the thing almost
               everybody means — and the two are DIFFERENT COLOURS, which is the
               one thing that row cannot do without. Two greys with the same
               black side read as a single bar, because the eye joins two
               identical lines at the same height, and the 2/3 · 1/3 split
               disappears exactly where that split is the whole message. -->
          ${this.creating
            ? this.form()
            : `<div class="menu-row">
                <button class="menu-btn go" id="menu-open-new" type="button">+ New shop</button>
                ${JOIN_ENABLED
    ? '<button class="menu-btn" id="menu-join" type="button">&#8644; Join</button>'
    : ''}
              </div>`}
        </div>

        <div class="menu-list">
          ${this.worlds.length
            ? this.worlds.map((w, i) => this.row(w, i)).join('')
            : '<div class="menu-empty">No shops yet. Start one above.</div>'}
        </div>

        <!-- THE TWO CONTROLS THAT ARE NOT ABOUT CHOOSING A SHOP, and they are
             inside the card now. Both were pinned to the SCREEN — the tip jar
             bottom-left, the mute bottom-right — so they sat out on the ground
             with nothing under them, which is what made them read as leftovers.
             As a footer they cost the list nothing, which was the whole reason
             they were moved out of the column in the first place.

             NEITHER GETS A BUTTON FACE: no fill, no line, no side, half opacity
             until you point at one. That is the panel close button's treatment,
             which is
             the panel's own answer for a control that is not part of the job —
             as chips they were two more objects competing with the thing
             somebody actually came here for, at the bottom of the card where the
             eye lands last.

             The tip jar is a plain <a>, deliberately. Every other press on this
             screen resolves the menu with a world, so a button that instead
             navigates away is the one control here whose outcome is a different
             kind of thing — and a link is the one widget every person alive
             already knows leaves the page. It also means the browser owns the
             middle-click, the long-press and the hover URL. What the label must
             never say is "buy me a coffee": the wording and the argument for it
             live in client/links.js. The rel=noopener matters more here than usual,
             because this tab holds an unsaved shop — and note that a backtick
             anywhere in this comment would end the template literal it is
             written inside, which is why there is not one in it.

             The mute quietens THIS SCREEN'S radio and nothing else. It shipped
             as mix.setMuted, which is the master knob the in-game Sound rows own
             — persisted and shared with the HUD — so hushing the front door
             followed you into the shop and took the tills, the doors and the
             crew with it. A hold on the music is the honest scope. -->
        <div class="menu-under">
          <a class="menu-support" href="${SUPPORT_URL}"
            target="_blank" rel="noopener noreferrer"
          >${ICONS.support}${SUPPORT_LABEL}</a>
          <span class="menu-busy">${this.busy ? 'Working…' : '&nbsp;'}</span>
          <button id="menu-mute" type="button" class="menu-mute"
            title="${this.hushed ? 'Menu music off' : 'Menu music on'}"
            aria-label="${this.hushed ? 'Turn the menu music on' : 'Turn the menu music off'}"
          >${this.hushed ? ICONS.muted : ICONS.speaker}</button>
        </div>
      </div>`;

    const list = this.root.querySelector('.menu-list');
    if (list) list.scrollTop = scroll;
    this.wire();
  }

  /* THE CONTOURS ARE CSS — see index.html, "WHO IS INKED".
   *
   * This screen used to hang a drawn <svg> stroke on eleven elements per
   * redraw, which is why Menu carried a ResizeObserver scope it had to clear
   * before every innerHTML. A ranked contour needs none of that, and there is
   * one of them now: the card. Everything inside it is a CREASE — the form's
   * own doctrine, applied to the whole screen — because a line eight pixels
   * inside another line is two boxes rather than a thing on a thing. */

  /**
   * The two listeners that belong to the ROOT rather than to a repaint.
   *
   * `render` replaces `root.innerHTML`, so anything wired in `wire` is wired
   * again on every redraw — which is right for elements that are themselves
   * replaced and quietly wrong for the root, which is not. These two are bound
   * once per Menu.
   *
   * The dropdowns are one delegated `click` and not a press-down closer, and
   * that ordering is the whole of why: a `pointerdown` that shuts the open list
   * removes the option you are pressing before the click can land on it, so
   * every pick would do nothing at all. One handler, in one order — pick, then
   * open, then "you pressed somewhere else, so close" — is also the only
   * spelling in which those three cannot disagree.
   */
  wireRoot() {
    if (this.rootWired) return;
    this.rootWired = true;

    this.root.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-drop-key]');
      if (opt) { this.pick(opt.dataset.dropKey, opt.dataset.dropVal); return; }
      const head = e.target.closest('[data-drop-open]');
      if (head) {
        this.openDrop = this.openDrop === head.dataset.dropOpen ? null : head.dataset.dropOpen;
        this.repaintForm();
        return;
      }
      if (this.openDrop) { this.openDrop = null; this.repaintForm(); }
    });

    // On the document, because the keyboard is not aimed at anything in
    // particular — and guarded on the menu being up, so it cannot answer an
    // Escape somebody meant for the shop. The menu is hidden rather than
    // removed when a world is picked (`play`), which is what makes that test
    // enough and this listener safe to leave attached.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || this.root.hidden || !this.openDrop) return;
      this.openDrop = null;
      this.repaintForm();
    });
  }

  wire() {
    const q = (sel) => this.root.querySelector(sel);

    q('#menu-open-new')?.addEventListener('click', () => {
      this.creating = true;
      this.render();
    });
    // Joining is not choosing a shop from this list — it is being let into
    // somebody else's, which this browser has no save for and never will. So it
    // resolves the menu with a live connection rather than a world id, and
    // `main.js` takes the two apart. See client/coop.js.
    q('#menu-join')?.addEventListener('click', async () => {
      const { showJoin } = await import('./coop.js');
      const guest = await showJoin({ name: this.name });
      if (guest) {
        this.root.hidden = true;
        this.resolve?.({ guest, name: this.name });
      }
    });
    q('#menu-cancel')?.addEventListener('click', () => { this.creating = false; this.render(); });
    // The saves list is the one thing on this screen that gives, and it gets
    // the game's scroller rather than the browser's: a drag, no bar, and a fade
    // at whichever end has more past it. Re-run on every render because `mark`
    // has to re-measure — the wiring itself only happens once (`data-scrolled`),
    // which is why re-calling it is cheap.
    wireScroll(q('.menu-list'), { axis: 'y' });
    q('#menu-mute')?.addEventListener('click', (e) => {
      // Still arms the mixer, because this may well be the first click on the
      // page and a hold applied to a graph that does not exist yet is a button
      // that appears to do nothing. Unmuting is then the ordinary case: the
      // press that armed the audio is usually the press that wanted it quiet.
      mix.arm();
      this.hushed = !this.hushed;
      music.hold('menu', this.hushed);
      const b = e.currentTarget;
      b.innerHTML = this.hushed ? ICONS.muted : ICONS.speaker;
      b.title = this.hushed ? 'Menu music off' : 'Menu music on';
      b.setAttribute('aria-label', this.hushed ? 'Turn the menu music on' : 'Turn the menu music off');
    });
    q('#menu-create')?.addEventListener('click', () => this.create());

    this.root.querySelectorAll('[data-play]').forEach((el) => {
      el.addEventListener('click', () => this.play(this.worlds[Number(el.dataset.play)]));
    });
    this.root.querySelectorAll('[data-del]').forEach((el) => {
      el.addEventListener('click', () => this.remove(this.worlds[Number(el.dataset.del)]));
    });
  }
}

/**
 * Which shop to open without asking, if anything already decided.
 *
 * `?world=<id>` is how you send someone a link straight into your shop, and how
 * an agent parks a browser tab in a particular world so `screenshot` has
 * something to photograph there.
 */
export function preselectedWorld() {
  return new URLSearchParams(location.search).get('world');
}
