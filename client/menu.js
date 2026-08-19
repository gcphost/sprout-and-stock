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
import { DIFFICULTIES, NEW_DIFFICULTY, difficultyOf } from '../shared/difficulty.js';
import { markWorldNew } from './tutor.js';
import { mix } from './audio/mix.js';
import { music } from './audio/music.js';
import { spinForWorker } from './thumb.js';
import { wireScroll } from './scroll.js';

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

/** `2 shelves`, `1 freezer` — a count and the word for it, agreeing. */
const some = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What a tier comes with, in shop words rather than field names.
 *
 * Derived from the same `fixtures` the server furnishes from, so the button
 * cannot promise a cooler the shop opens without — the rule `client/thumb.js`
 * follows about drawing a fixture from its own catalog row, said about a list.
 */
const kitLine = (t) => [
  some(t.fixtures.shelf, 'shelf', 'shelves'),
  some(t.fixtures.freezer, 'freezer'),
  some(t.fixtures.checkout, 'till'),
  some(t.fixtures.plot, 'bed'),
].join(' · ');

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

/**
 * The menu over HTTP — the server build, and the default.
 *
 * Four calls: list the shops, list the worker kinds a card draws a bot from,
 * make one, throw one away.
 */
async function httpApi(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: `${res.status}` }));
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `${res.status}`);
  return json;
}

let transport = httpApi;

/**
 * Point the menu at something other than HTTP.
 *
 * The web build has no HTTP and no server; its worker owns the store and
 * answers the same four calls in the same shapes (`LocalNet.api`). A swap here
 * rather than a branch inside `api` for the reason the whole port is built on:
 * the thing being replaced is a *transport*, and the moment this file can tell
 * which one it has, the menu has learned which build it is in.
 *
 * Deliberately module-level rather than a constructor argument. `Menu` is
 * created in more than one place (the front door, and Leave from the Controls
 * panel), and a parameter is a parameter somebody forgets at one of them — at
 * which point one route into the menu quietly tries to `fetch` in a build with
 * nothing to fetch from.
 */
export function setMenuApi(fn) {
  transport = fn ?? httpApi;
}

const api = (method, path, body) => transport(method, path, body);

const REMEMBERED = 'sns-world';

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
      // The crew, for the turntable over the title. Off the same content API the
      // rest of the menu uses rather than the catalog, because there is no
      // socket yet — this screen runs before there is a shop to be told about
      // one. Fetched once and kept: `refresh` runs on every delete and every
      // arm, and a bot that changed identity each time you armed a Delete would
      // read as the page reloading under you.
      if (!this.crew) {
        const got = await api('GET', '/content/worker').catch(() => null);
        this.crew = got?.rows ?? [];
      }
      this.error = null;
    } catch (err) {
      this.error = `Can't reach the shop: ${err.message}`;
    }
    this.render();
  }

  /**
   * One of your crew, turning, over the title.
   *
   * The same filmstrip the worker sheet uses (`spinForWorker` — twenty-four
   * stills fifteen degrees apart, slid one frame at a time by `steps()`), for
   * the reason it is a filmstrip there: there is no renderer on this screen and
   * there is no socket either, so anything that needed either would be a second
   * way of drawing a robot that has to be kept matching the first.
   *
   * **Which** one is `hash01`'s argument said about a day rather than a person:
   * picked off the date, so the front door has somebody different on it when you
   * come back tomorrow and the same one all evening. Drawn from `this.crew`
   * rather than re-picked per render, or arming a Delete would swap the bot.
   *
   * A shop with no worker art authored gets nothing at all — no placeholder,
   * because a grey silhouette over the title is worse than a title.
   */
  greeter() {
    const rows = (this.crew ?? []).filter((w) => w.model);
    if (!rows.length) return '';
    this.who ??= rows[Math.floor(Date.now() / 864e5) % rows.length];
    const frames = spinForWorker(this.who, 1, null);
    if (!frames?.length) return '';
    // A negative delay is "start this far in", so the turn survives the
    // rebuild `render` does on every keystroke that matters — without it the
    // bot snaps back to facing front each time you type in the name box.
    const phase = (-(performance.now() / 1000) % 9).toFixed(2);
    return `<div class="menu-bot" aria-hidden="true">
      <span class="wk-turn" style="--n:${frames.length};--spin:9s;animation-delay:${phase}s">${
  frames.map((f) => `<span>${f}</span>`).join('')}</span>
    </div>`;
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
    const detail = this.root.querySelector('.tdetail');
    if (detail) detail.innerHTML = `<b>${esc(kitLine(t))}</b> ${esc(t.blurb)}`;
    const cash = this.root.querySelector('#menu-new-cash');
    if (cash) cash.placeholder = t.cash;
  }

  /**
   * ...and the same for how hard the town is, in place for the same reason.
   *
   * Two things depend on it and neither is the cash box: which button is lit,
   * and the line under the row. Kept as its own method rather than folded into
   * `pickTier` because the two rows are two questions — a redraw of one must not
   * touch the other's choice, which is exactly what a shared `render` would do.
   */
  pickDifficulty(id) {
    this.difficulty = id;
    this.root.querySelectorAll('[data-diff]').forEach((el) => {
      el.classList.toggle('on', el.dataset.diff === id);
    });
    const detail = this.root.querySelector('.ddetail');
    if (detail) detail.textContent = difficultyOf(id).blurb;
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
        ${this.greeter()}
        <h1>Sprocket <span>&amp;</span> Stock</h1>
        <p class="menu-tag">Run a shop with a crew of robots. You're the only human in it.</p>

        <label class="menu-field">
          <span>You are</span>
          <input id="menu-name" maxlength="20" placeholder="your name"
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
              <label class="menu-field">
                <span>Called</span>
                <input id="menu-new-name" maxlength="32" placeholder="Corner Shop"
                  ${NO_FILL} />
              </label>
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
                  <button class="tier${t.id === this.tier ? ' on' : ''}" data-tier="${t.id}">
                    <b>${esc(t.name)}</b><span>${money(t.cash)}</span>
                  </button>`).join('')}
              </div>
              <p class="tdetail">
                <b>${esc(kitLine(startTier(this.tier)))}</b>
                ${esc(startTier(this.tier).blurb)}
              </p>
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
                  <button class="tier${d.id === this.difficulty ? ' on' : ''}" data-diff="${d.id}">
                    <b>${esc(d.name)}</b>
                  </button>`).join('')}
              </div>
              <p class="tdetail ddetail">${esc(difficultyOf(this.difficulty).blurb)}</p>
              <label class="menu-field">
                <span>Cash</span>
                <input id="menu-new-cash" type="number" min="0" max="1000000"
                  ${NO_FILL} placeholder="${startTier(this.tier).cash}" />
              </label>
              <!-- ...and no paragraph under it either. Everything it said is
                   said by the thing it was describing: the cash box's
                   placeholder is its own default, a silly number is clamped
                   rather than refused, and the sizes above already name what
                   they come with. "You can only choose this now" is a rule
                   about a form you are looking at once. -->
              <div class="wacts">
                <button class="wplay" id="menu-create">Start it</button>
                <button class="wghost" id="menu-cancel">Cancel</button>
              </div>
            </div>`
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

  wire() {
    const q = (sel) => this.root.querySelector(sel);

    q('#menu-open-new')?.addEventListener('click', () => { this.creating = true; this.render(); q('#menu-new-name')?.focus(); });
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

    if (this.creating) q('#menu-new-name')?.focus();
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
