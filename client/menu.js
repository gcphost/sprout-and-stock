/**
 * THE FRONT DOOR — pick a shop, or start a new one.
 *
 * This is the one screen that is not a HUD panel, and that is deliberate.
 * `docs/ui-shell.md` says anything that lists or offers actions goes in
 * `#panel`, because a second floating div over the world goes stale, survives
 * re-flows it shouldn't and eats the Escape key. None of that applies here:
 * there is no world yet. The panel system draws over a running game and reads
 * from a snapshot; this draws before there is a socket, and reads from HTTP.
 *
 * It resolves with the world you chose, and `main.js` connects to that. Nothing
 * else in the client knows there is more than one shop.
 */

import { money } from './money.js';
import { START_TIERS, DEFAULT_TIER, startTier } from '../shared/start.js';
import { DIFFICULTIES, NEW_DIFFICULTY } from '../shared/difficulty.js';
import { defaultPiece } from '../shared/pieces.js';
import { NAME_MAX, SHOP_NAME_MAX } from '../shared/names.js';
// Which grammar this is being played with — here, whether focusing a field
// summons a keyboard over half the screen. See `caret`.
import { pillDrives } from './input.js';
import { artForPiece } from './thumb.js';
import { markWorldNew } from './tutor.js';
import { mix } from './audio/mix.js';
import { music } from './audio/music.js';
import { loadCrew, greeterOfTheDay, turntable } from './greeter.js';
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
 * KEEP THE PASSWORD MANAGERS OFF THIS SCREEN.
 *
 * Nothing in this game is an account. There is no login, no `<form>` element
 * anywhere in the client, no password field and no submission — `who` is a
 * string minted into localStorage (see client/net.js) and the name box is
 * cosmetic. So the browser's own "save password?" prompt cannot fire, and none
 * of this is about the browser.
 *
 * It is about the EXTENSIONS. A lone text input labelled "You are" on a title
 * screen is, to a password manager's heuristics, a username box on a login page
 * — so it gets an inline icon, an offer to fill, and on some of them a dropdown
 * over the button underneath. What that costs is not privacy, it is the first
 * ten seconds of the game: the front door reads as a sign-up, on a game that has
 * deliberately never asked anybody for an account.
 *
 * `autocomplete="off"` alone does not do it and is documented not to — Chrome
 * ignores it wherever its own heuristics think they know better, and no
 * extension has ever read it. Each manager ships its own opt-out attribute
 * instead, so the list is a list because the vendors made it one. Unknown
 * attributes are inert everywhere else, which is why carrying five costs
 * nothing.
 *
 * One constant rather than five attributes typed onto each input: the failure
 * mode of the copy-paste version is the field somebody adds next year, and a
 * form where two boxes are quiet and the third pops an icon is worse than one
 * where they all do.
 *
 * Deliberately NOT here: `autocapitalize` and `spellcheck`. Both are about the
 * keyboard rather than about autofill, and both are things a name field wants —
 * turning them off with the rest would be a tidy-looking way to stop a phone
 * capitalising somebody's name for them.
 */
const NO_FILL = 'autocomplete="off" '
  + 'data-1p-ignore data-lpignore="true" data-bwignore="true" '
  + 'data-protonpass-ignore="true" data-form-type="other"';

/**
 * Put the caret in a field — on a device where that is all it does.
 *
 * Focusing the shop name is right on a keyboard: the form has four fields, three
 * of which you were always going to skip, and landing in the one you might type
 * in saves a click on the thing everybody does first.
 *
 * On a phone it is the opposite, because focus there does not put a caret in a
 * box — it raises the system keyboard, which is half the screen. The form is
 * shorter than that half, so opening the new-shop panel covers the tier prices,
 * the starting kit, the difficulty and the Start button with a keyboard, for a
 * field with a perfectly good default already in it. What you actually have to
 * do first is dismiss it.
 *
 * The fields are untouched — every one of them still takes a tap and a type, and
 * the placeholder is the default either way. What goes is the *assumption* that
 * you came here to type, which is only a safe assumption where being wrong about
 * it costs a click rather than the screen.
 */
const caret = (el) => { if (el && !pillDrives()) el.focus(); };

/**
 * The build catalog, for the pictures in the new-shop form.
 *
 * The fifth thing this screen asks for over HTTP, and added on purpose the way
 * `client/worker.js` says a fifth should be. Off the content API rather than
 * the game's catalog for the reason `loadCrew` gives about the worker kinds:
 * neither screen that wants art has a socket yet.
 *
 * Module-level and fetched once, so the form repainting on every keystroke that
 * matters is not a request. Not remembered in localStorage the way the crew is
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

/** The four things a starting kit is counted in, and the word for each. */
const KIT = [
  { kind: 'shelf', one: 'shelf', many: 'shelves' },
  { kind: 'freezer', one: 'freezer', many: 'freezers' },
  { kind: 'checkout', one: 'till', many: 'tills' },
  { kind: 'plot', one: 'bed', many: 'beds' },
  { kind: 'pen', one: 'pen', many: 'pens' },
];

/**
 * What a tier comes with, as the things themselves.
 *
 * A tile per kind, and the art is `defaultPiece` → `artForPiece` — the same two
 * calls a fixture standing in the shop is drawn through, so the form cannot
 * promise a cooler the shop opens without and no second picture of a shelf has
 * to be kept matching the first. That is `client/thumb.js`'s whole rule, said
 * about a form rather than about a palette button.
 *
 * A kind with no art draws its number and its word and nothing else, which is
 * the same answer the front door already gives a build with no worker art
 * authored: a grey silhouette is worse than a gap.
 */
function kitTiles(t) {
  return KIT.map(({ kind, one, many }) => {
    const n = t.fixtures[kind] ?? 0;
    if (!n) return '';
    const art = artForPiece(defaultPiece(pieces, kind), kind);
    return `<div class="kitem">
        <div class="kart">${art ?? ''}</div>
        <div class="knum"><b>&times;${n}</b> <span>${n === 1 ? one : many}</span></div>
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
 * How long "click again to delete" stays armed.
 *
 * Same latch the worker menu uses for letting someone go, and for the same
 * reason: the row is one button from Play, and nothing comes back. A modal
 * would ask harder, but it asks *somewhere else* — you read a dialog about a
 * name instead of looking at the card you meant to keep.
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
    // than read off the DOM at submit time because `render` rebuilds the box
    // from `innerHTML` on every keystroke that matters — see `create`, which
    // learnt the same lesson about the text fields the hard way.
    this.tier = DEFAULT_TIER;
    // The *creation* default, which is deliberately not the one a save with
    // nothing to say reads as — see shared/difficulty.js. The form offering
    // `relaxed` would quietly make the gentle game the one everybody keeps
    // getting, which is the thing this whole preset exists to stop.
    this.difficulty = NEW_DIFFICULTY;
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
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.refresh();
    });
  }

  async refresh() {
    try {
      const { worlds } = await api('GET', '/worlds');
      this.worlds = worlds;
      // A list of nothing is not a choice, so the form is what this screen IS
      // on a first run: opening on an empty list and a button that says "+ New
      // shop" is one press spent on the only thing there is to do. Here rather
      // than in the constructor because it is a fact about the answer, not
      // about the screen — and it comes back if you delete your last shop,
      // which is the same first run wearing a later day. Cancel still shuts it
      // (that redraws without refetching), so it is a default and not a latch.
      if (!this.worlds.length) this.creating = true;
      // The crew, for the turntable over the title. `loadCrew` keeps it for the
      // life of the page, which is what makes this cheap to call from
      // `refresh` — that runs on every delete and every arm, and a bot that
      // changed identity each time you armed a Delete would read as the page
      // reloading under you. The loading screen behind this one has usually
      // fetched it already.
      await loadCrew(api);
      // Before the paint rather than after it: the strip is drawn from these
      // rows, and art that lands a tick late is a form that reflows under
      // somebody reading it. Both are one fetch for the life of the page.
      await loadPieces();
      this.error = null;
    } catch (err) {
      this.error = `Can't reach the shop: ${err.message}`;
    }
    this.render();
  }

  /**
   * One of your crew, turning, over the title. See client/greeter.js — the
   * loading screen stands the same bot in front of the same sky, and the pick
   * is per-DAY rather than per-render so neither screen has to tell the other
   * which machine it chose.
   */
  greeter() {
    return turntable(greeterOfTheDay());
  }

  get name() {
    return this.root.querySelector('#menu-name')?.value.trim()
      ?? localStorage.getItem('sns-name') ?? '';
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
    const name = this.name;
    if (name) localStorage.setItem('sns-name', name);
    localStorage.setItem(REMEMBERED, world.id);
    this.root.hidden = true;
    this.resolve?.({ worldId: world.id, name, world });
  }

  /**
   * Switch which size of shop the form is offering.
   *
   * In place rather than by redrawing, and both halves of that are the point.
   * `render` rebuilds the box from `innerHTML`, so a redraw would throw away
   * whatever cash you had typed — the trap `create` documents at length — and
   * it would move the caret to the name field, three rows above the thing you
   * just clicked. Only three things depend on the choice, so all three are
   * moved by hand: which button is lit, what the shop comes with, and what the
   * empty cash box is promising.
   */
  pickTier(id) {
    this.tier = id;
    const t = startTier(id);
    this.root.querySelectorAll('[data-tier]').forEach((el) => {
      el.classList.toggle('on', el.dataset.tier === id);
    });
    const kit = this.root.querySelector('.kitrow');
    if (kit) kit.innerHTML = kitTiles(t);
    const cash = this.root.querySelector('#menu-new-cash');
    if (cash) cash.placeholder = t.cash;
  }

  /**
   * ...and the same for how hard the town is, in place for the same reason.
   *
   * One thing depends on it — which button is lit. Kept as its own method
   * rather than folded into `pickTier` because the two rows are two questions:
   * a redraw of one must not touch the other's choice, which is exactly what a
   * shared `render` would do.
   */
  pickDifficulty(id) {
    this.difficulty = id;
    this.root.querySelectorAll('[data-diff]').forEach((el) => {
      el.classList.toggle('on', el.dataset.diff === id);
    });
  }

  /**
   * Making a shop drops you straight into it.
   *
   * The alternative — create, then find it in the list, then press Play — is
   * two extra decisions after you already said what you wanted, and the list is
   * sorted by last played, so a brand new world is not where you are looking.
   */
  async create() {
    // Read the form BEFORE `act`, never inside it. `act` renders to show
    // "Working…", and `render` rebuilds the whole box from innerHTML — so every
    // input is a brand new empty element by the time the callback runs, and
    // every field arrives at the server as "". That is invisible from the code
    // and silent in the game: you type 9999, the server is told nothing, and you
    // start on the default with no error anywhere to say why.
    const field = (id) => this.root.querySelector(id)?.value.trim() ?? '';
    // Sent as typed, blanks and all: the server reads an empty box as "you
    // didn't say" and uses the default, which is the same thing the greyed-out
    // number in the box is promising. Parsing here would mean two opinions
    // about what "" means, and the placeholders would only be right by luck.
    const asked = {
      name: field('#menu-new-name'),
      tier: this.tier,
      difficulty: this.difficulty,
      cash: field('#menu-new-cash'),
    };
    await this.act(async () => {
      const { world } = await api('POST', '/worlds', asked);
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
   * Deleting asks first, and asks on the card rather than in a dialog.
   *
   * It is the only way a shop ever disappears — nothing expires a save — and the
   * row it sits on is two rows from Play. So the first click only arms it: the button
   * says what a second one does, the card says what goes with it, and the shop
   * you are about to lose is still in front of you with its day and its cash
   * on it. A `confirm()` had to reprint all of that, badly, and by name.
   *
   * Which is why arming may not resize anything: the warning takes over the
   * `.wsub` line's cell and the button holds both spellings of its label, so
   * the card is the same size armed as not (`.wswap`, index.html). Growing the
   * card moved every card below it — and the Play button of the one you were
   * aiming at — under a cursor that had just been told to click again.
   */
  async remove(world) {
    if (!this.armed(world)) {
      clearTimeout(this.armTimer);
      this.arm = { id: world.id, at: Date.now() };
      // Nothing here ticks, so the latch has to expire itself or the card sits
      // saying "click again" long after clicking again has stopped deleting.
      this.armTimer = setTimeout(() => this.disarm(true), DELETE_ARM_MS);
      this.render();
      return;
    }
    await this.act(() => api('DELETE', `/worlds/${encodeURIComponent(world.id)}`));
  }

  // ---- drawing ------------------------------------------------------------

  card(w, i) {
    const last = localStorage.getItem(REMEMBERED) === w.id;
    const arm = this.armed(w);
    return `
      <div class="wcard${last ? ' last' : ''}${arm ? ' arm' : ''}">
        <div class="wtop">
          <div class="wname">${esc(w.name)}</div>
          ${w.live ? `<span class="wlive">${w.players
            ? `${w.players} playing`
            : 'open'}</span>` : ''}
        </div>
        <div class="wstats">
          <b>Day ${w.day}</b><span>${money(w.cash)}</span><span>${esc(w.season)}</span>
        </div>
        <div class="wswap${arm ? ' on' : ''}">
          <div class="wsub">
            ${w.upgrades} upgrade${w.upgrades === 1 ? '' : 's'} ·
            ${w.staff} staff · played ${ago(w.played_at)}
          </div>
          <div class="wwarn">This shop goes for good. Items and crops you made stay.</div>
        </div>
        <div class="wacts">
          <button class="wplay" data-play="${i}">${w.live ? 'Join' : 'Play'}</button>
          <button class="wghost wdel wswap${arm ? ' on' : ''}" data-del="${i}"
            ><span>Delete</span><span>Click again</span></button>
        </div>
      </div>`;
  }

  render() {
    // The loading screen steps aside HERE rather than when the menu is
    // unhidden, and the gap between the two is a fetch. Both screens draw the
    // same sky (`.outdoors`), so they cannot both be up — two copies composite
    // and the sun doubles — and hiding the loader at `choose()` would leave an
    // empty sky for as long as `/worlds` takes, which is precisely the wait the
    // loader exists for. Unconditional and idempotent: after the shop opens the
    // element is gone, and the Leave path builds a second Menu against it.
    bootHide();
    const name = localStorage.getItem('sns-name') ?? '';
    // The LIST is the scroll container now, and it is inside the thing being
    // rebuilt — so emptying `root` collapses it and the browser pins it to 0.
    // With eight shops that reads as the menu jumping to the top every time you
    // arm or delete one, and the card you clicked leaves the screen. Read off
    // `.menu-list` rather than off `root`: root has not scrolled since the page
    // stopped scrolling, so the old line restored 0 onto 0 and quietly did
    // nothing — which is worse than being wrong, because it still looks right.
    const scroll = this.root.querySelector('.menu-list')?.scrollTop ?? 0;
    this.root.innerHTML = `
      <div class="menu-box">
        <!-- The one control on this screen that is not about choosing a shop.
             The radio and the Sound rows both live in the HUD, and the HUD does
             not exist yet — so the music starts on your first click here and
             there is nothing anywhere to turn it off with. Somebody opening
             this at their desk has no way to shut the game up short of the tab
             mute, which is the browser doing the game's job.

             It quietens THIS SCREEN'S radio and nothing else. It shipped as
             mix.setMuted, which is the master knob the in-game Sound rows own —
             persisted to localStorage and shared with the HUD — so hushing the
             front door followed you into the shop and took the tills, the doors
             and the crew with it. What that reads as is a game whose sound never
             came back, hours later, with nothing connecting it to a button on a
             screen you saw once. A hold on the music is the honest scope: the
             radio only, and released the moment this screen goes. -->
        <button id="menu-mute" type="button" class="menu-mute"
          title="${this.hushed ? 'Menu music off' : 'Menu music on'}"
          aria-label="${this.hushed ? 'Turn the menu music on' : 'Turn the menu music off'}"
        >${this.hushed ? '🔇' : '🔊'}</button>

        <!-- The tip jar, and this is the one screen it belongs on: it is the
             only moment in the game where nobody is mid-anything. Asking from
             the HUD interrupts a shop; asking on the front door does not.

             It sits in the OPPOSITE CORNER to the mute button and for the same
             reason, which is why the two are written next to each other. In the
             column it was a sentence and a button between the last save and the
             bottom of the box — a whole section of the menu, at the weight of
             the thing somebody actually came here for, pushing the list of
             shops up the screen to make room for an ask nobody arrived to
             answer. Fixed to the corner it costs the menu nothing and is still
             there to be found. It is early in the markup rather than last
             because it is out of flow: where it sits in here decides nothing,
             and it belongs beside the other bit of screen furniture.

             THE LINE THAT USED TO BE ABOVE IT IS GONE, and gone rather than
             tucked into a tooltip: a caption pinned under a 440px column on a
             phone is not a footnote, it is a paragraph lying across the bottom
             of the menu, which is the complaint that moved this here in the
             first place. The Menu's own row carried those words for a while
             afterwards and has since dropped them too — see client/links.js:
             the label says the whole thing, and a caption under it is a pitch.

             A plain <a> rather than a row with a handler, deliberately. Every
             other press on this screen resolves the menu with a world, so a
             button that instead navigates away is the one control here whose
             outcome is a different kind of thing — and a link is the one widget
             every person alive already knows leaves the page. It also means the
             browser owns the middle-click, the long-press and the hover URL,
             none of which a handler would have given back.

             It is a BUTTON to look at and a link to use. As a bare hyperlink it
             was the only underlined text on a screen made entirely of tiles, in
             the one colour this palette reserves for marks — which is why it
             read as an error message rather than as an offer. It borrows
             .menu-add's language at two thirds the size: same cream, same inset
             keyline, same press-down, quieter than the button somebody actually
             came here for.

             What the label must never say is "buy me a coffee" — there is no
             "me" here, and the coffee is the donation platform's metaphor
             rather than this game's. The wording and the argument for it live
             in client/links.js.

             noopener matters more here than usual: this tab holds an unsaved
             shop. See client/links.js — and note that a backtick anywhere in
             this comment would end the template literal it is written inside,
             which is why there is not one in it. -->
        <a class="menu-support" href="${SUPPORT_URL}"
          target="_blank" rel="noopener noreferrer"
        >${ICONS.support}${SUPPORT_LABEL}</a>

        ${this.greeter()}
        <h1>Sprocket <span>&amp;</span> Stock</h1>
        <p class="menu-tag">Run a shop with a crew of robots. You're the only human in it.</p>

        <label class="menu-field">
          <span>You are</span>
          <input id="menu-name" maxlength="${NAME_MAX}" placeholder="your name"
            ${NO_FILL} value="${esc(name)}" />
        </label>

        ${this.notice ? `<div class="menu-err soft">${esc(this.notice)}</div>` : ''}
        ${this.error ? `<div class="menu-err">${esc(this.error)}</div>` : ''}

        <!-- Starting one comes BEFORE the list of them, and the form takes the
             button's place rather than opening under it. Both are the same
             point: what you came here to do is at the top either way, and a
             list that grows by one every time you play does not push it further
             down the page each time. -->
        ${this.creating
          ? `<div class="menu-new">
              <!-- The two things you TYPE, on one line. They were three rows
                   apart with the sizes and the difficulty between them, which
                   made the money read as a consequence of the choices rather
                   than as a box — and the cash box is the one field whose whole
                   job is to disagree with the size you picked. Two thirds to the
                   name because it wraps and a number does not. -->
              <div class="menu-duo">
                <label class="menu-field">
                  <span>Called</span>
                  <input id="menu-new-name" maxlength="${SHOP_NAME_MAX}" placeholder="Corner Shop"
                    ${NO_FILL} />
                </label>
                <!-- No paragraph under it. Everything one said is said by the
                     thing it was describing: the placeholder is the default for
                     the size that is lit, and a silly number is clamped rather
                     than refused. "You can only choose this now" is a rule about
                     a form you are looking at once. -->
                <label class="menu-field mf-cash">
                  <span>Cash</span>
                  <input id="menu-new-cash" type="number" min="0" max="1000000"
                    ${NO_FILL} placeholder="${startTier(this.tier).cash}" />
                </label>
              </div>
              <!-- No seed box. It was a field whose honest label is "type
                   something and the building will be different", which is a
                   question nobody starting a shop has an answer to — and the
                   only way to use it well is to have played the seed already.
                   The API still takes one, because a balance run comparing two
                   worlds needs to name the same building twice; a person gets a
                   random one. -->
              <!-- How much shop, rather than how many shelves. The three
                   numbers that were here asked you to size a building before
                   you had seen one — and the middle one silently sized the
                   *building*, because the generator grows the shop until its
                   contents fit. So the sizes are named, and each says what it
                   comes with. See shared/start.js. -->
              <div class="tiers">
                ${START_TIERS.map((t) => `
                  <button class="tier${t.id === this.tier ? ' on' : ''}" data-tier="${t.id}"
                    title="${esc(t.blurb)}">
                    <b>${esc(t.name)}</b><span>${money(t.cash)}</span>
                  </button>`).join('')}
              </div>
              <!-- ...and what that size actually is, in things rather than in a
                   sentence. It was two lines of prose — the four counts spelled
                   out, then a paragraph saying the same in shop words — sitting
                   directly above a second paragraph about the difficulty, which
                   is a form that reads as a page of notes. The pictures say the
                   counts, so what is left in words is the one thing no picture
                   can show: what the town is like. The tier's own sentence is
                   still on the button it belongs to. -->
              <div class="kit">
                <span class="kithead">You open with</span>
                <div class="kitrow">${kitTiles(startTier(this.tier))}</div>
              </div>
              <!-- ...and how hard the town is, which is the OTHER axis and
                   deliberately its own row. Size is where you begin; this is
                   what happens next, and folding them into one list of six
                   buttons would mean the only way to play a hard game is to
                   play a small one. See shared/difficulty.js.

                   No numbers on these buttons, where the sizes carry their
                   cash. A tier's number is a thing you can hold in your hand on
                   day one; "a bad week settles at 22% reputation" is not a
                   comparison anybody can make before they have played, so the
                   blurb says what it feels like instead. -->
              <div class="tiers">
                ${DIFFICULTIES.map((d) => `
                  <button class="tier${d.id === this.difficulty ? ' on' : ''}" data-diff="${d.id}"
                    title="${esc(d.blurb)}">
                    <b>${esc(d.name)}</b>
                  </button>`).join('')}
              </div>
              <div class="wacts">
                <button class="wplay" id="menu-create">Start it</button>
                <button class="wghost" id="menu-cancel">Cancel</button>
              </div>
            </div>
            <!-- Joining outlives the form, which it did not have to before the
                 form could be what you land on. A guest is somebody with no
                 saves of their own — exactly the empty list that now opens this
                 — so hiding Join behind Cancel would put the one thing they
                 came for behind a button that reads as backing out. -->
            ${JOIN_ENABLED ? `<div class="menu-adds menu-alt">
              <button class="menu-add menu-side" id="menu-join">⇄ Join a friend</button>
            </div>` : ''}`
          : `<div class="menu-adds"><button class="menu-add" id="menu-open-new">+ New shop</button>${
            JOIN_ENABLED ? '<button class="menu-add menu-side" id="menu-join">⇄ Join a friend</button>' : ''}</div>`}

        <div class="menu-list">
          ${this.worlds.length
            ? this.worlds.map((w, i) => this.card(w, i)).join('')
            : '<div class="menu-empty">No shops yet. Start one above.</div>'}
        </div>

        <p class="menu-foot">${this.busy ? 'Working…' : '&nbsp;'}</p>
      </div>`;

    const list = this.root.querySelector('.menu-list');
    if (list) list.scrollTop = scroll;
    this.wire();
  }

  /* THE CONTOURS ARE CSS NOW — see index.html, "WHO IS INKED".
   *
   * This screen used to hang a drawn <svg> stroke on eleven elements per
   * redraw, which is why Menu carried a ResizeObserver scope it had to clear
   * before every innerHTML. A ranked contour needs none of that: the six
   * selectors that used to be listed here are six selectors in the
   * stylesheet, and a rebuilt card is inked the instant it exists.
   *
   * WHAT SURVIVES IS THE RULE, and it is worth keeping where the markup is:
   * only things that are objects IN THEIR OWN RIGHT get a contour. Something
   * standing inside a card is a crease (--crease, and the doctrine .menu-new
   * spells out with --line) — give Delete its own outline and the card has a
   * line, then a second line eight pixels inside it round a button, which is
   * two boxes rather than a thing on a thing. So: the paper (.wcard,
   * .menu-new) and the standalone controls on the sky (.menu-add,
   * .menu-support, .menu-err, and the name box only).
   *
   * The name box is a CHILD selector there for the same reason it was here:
   * the shop-name and cash boxes wear the same class and stand INSIDE
   * .menu-new, so they are the crease case above. */

  wire() {
    const q = (sel) => this.root.querySelector(sel);

    q('#menu-open-new')?.addEventListener('click', () => { this.creating = true; this.render(); caret(q('#menu-new-name')); });
    // Joining is not choosing a shop from this list — it is being let into
    // somebody else's, which this browser has no save for and never will. So it
    // resolves the menu with a live connection rather than a world id, and
    // `main.js` takes the two apart. See client/coop.js.
    q('#menu-join')?.addEventListener('click', async () => {
      const { showJoin } = await import('./coop.js');
      const guest = await showJoin({ name: localStorage.getItem('sns-name') ?? '' });
      if (guest) this.resolve?.({ guest });
    });
    q('#menu-cancel')?.addEventListener('click', () => { this.creating = false; this.render(); });
    // Repainted in place rather than through `render`, which rebuilds the box
    // from innerHTML and would throw away the name and cash somebody has typed
    // — the trap `create` documents at length, and a mute button is exactly the
    // sort of press you make while half way through filling the form in.
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
      b.textContent = this.hushed ? '🔇' : '🔊';
      b.title = this.hushed ? 'Menu music off' : 'Menu music on';
      b.setAttribute('aria-label', this.hushed ? 'Turn the menu music on' : 'Turn the menu music off');
    });
    q('#menu-create')?.addEventListener('click', () => this.create());

    // Enter anywhere in the new-shop form starts it. A form with a button you
    // have to aim at is a form people abandon — more so now it is four fields
    // deep and three of them are ones you were always going to skip.
    this.root.querySelectorAll('.menu-new input').forEach((el) => {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.create(); });
    });

    this.root.querySelectorAll('[data-tier]').forEach((el) => {
      el.addEventListener('click', () => this.pickTier(el.dataset.tier));
    });

    this.root.querySelectorAll('[data-diff]').forEach((el) => {
      el.addEventListener('click', () => this.pickDifficulty(el.dataset.diff));
    });

    this.root.querySelectorAll('[data-play]').forEach((el) => {
      el.addEventListener('click', () => this.play(this.worlds[Number(el.dataset.play)]));
    });
    this.root.querySelectorAll('[data-del]').forEach((el) => {
      el.addEventListener('click', () => this.remove(this.worlds[Number(el.dataset.del)]));
    });

    if (this.creating) caret(q('#menu-new-name'));
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
