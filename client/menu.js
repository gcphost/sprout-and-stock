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

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

const money = (n) => `$${Number(n ?? 0).toFixed(2)}`;

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

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: `${res.status}` }));
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `${res.status}`);
  return json;
}

const REMEMBERED = 'sns-world';

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
    // `{ id, at }` for the one shop whose Delete is armed. By id, not by index:
    // a refresh re-sorts the list, and an armed row number would end up over
    // somebody else's shop.
    this.arm = null;
    this.armTimer = null;
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
      this.error = null;
    } catch (err) {
      this.error = `Can't reach the shop: ${err.message}`;
    }
    this.render();
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
    const name = this.name;
    if (name) localStorage.setItem('sns-name', name);
    localStorage.setItem(REMEMBERED, world.id);
    this.root.hidden = true;
    this.resolve?.({ worldId: world.id, name, world });
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
      seed: field('#menu-new-seed'),
      cash: field('#menu-new-cash'),
      shelves: field('#menu-new-shelves'),
      plots: field('#menu-new-plots'),
    };
    await this.act(async () => {
      const { world } = await api('POST', '/worlds', asked);
      this.play(world);
    });
  }

  /**
   * Deleting asks first, and asks on the card rather than in a dialog.
   *
   * The sweeper can take an unpinned world that has sat for a fortnight, which
   * makes this the one place a shop disappears *immediately* — and the row it
   * sits on is two rows from Play. So the first click only arms it: the button
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

  async togglePin(world) {
    await this.act(() => api('PATCH', `/worlds/${encodeURIComponent(world.id)}`, { pinned: !world.pinned }));
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
            ${w.pinned ? ' · kept' : ''}
          </div>
          <div class="wwarn">This shop goes for good. Items and crops you made stay.</div>
        </div>
        <div class="wacts">
          <button class="wplay" data-play="${i}">${w.live ? 'Join' : 'Play'}</button>
          <button class="wghost wswap${w.pinned ? ' on' : ''}" data-pin="${i}" title="${w.pinned
            ? 'Kept — never cleaned up automatically'
            : 'Keep this shop, whatever happens'}"><span>Keep</span><span>Kept</span></button>
          <button class="wghost wdel wswap${arm ? ' on' : ''}" data-del="${i}"
            ><span>Delete</span><span>Click again</span></button>
        </div>
      </div>`;
  }

  render() {
    const name = localStorage.getItem('sns-name') ?? '';
    // `this.root` is the scroll container as well as the thing being rebuilt,
    // so emptying it collapses the content and the browser pins scroll to 0.
    // With eight shops in the list that reads as the menu jumping to the top
    // every time you arm, pin or delete one — the card you clicked leaves the
    // screen. Nothing above resizes now, so putting it back always lands.
    const scroll = this.root.scrollTop;
    this.root.innerHTML = `
      <div class="menu-box">
        <h1>Sprout <span>&amp;</span> Stock</h1>
        <p class="menu-tag">A farming and mini-mart game for two.</p>

        <label class="menu-field">
          <span>You are</span>
          <input id="menu-name" maxlength="20" placeholder="your name" value="${esc(name)}" />
        </label>

        ${this.notice ? `<div class="menu-err soft">${esc(this.notice)}</div>` : ''}
        ${this.error ? `<div class="menu-err">${esc(this.error)}</div>` : ''}

        <div class="menu-list">
          ${this.worlds.length
            ? this.worlds.map((w, i) => this.card(w, i)).join('')
            : '<div class="menu-empty">No shops yet. Start one below.</div>'}
        </div>

        ${this.creating
          ? `<div class="menu-new">
              <label class="menu-field">
                <span>Called</span>
                <input id="menu-new-name" maxlength="32" placeholder="Corner Shop" />
              </label>
              <label class="menu-field">
                <span>Seed</span>
                <input id="menu-new-seed" maxlength="24" placeholder="leave blank for a surprise" />
              </label>
              <div class="menu-row">
                <label class="menu-field">
                  <span>Cash</span>
                  <input id="menu-new-cash" type="number" min="0" max="1000000" placeholder="250" />
                </label>
                <label class="menu-field">
                  <span>Shelves</span>
                  <input id="menu-new-shelves" type="number" min="1" max="25" placeholder="6" />
                </label>
                <label class="menu-field">
                  <span>Plots</span>
                  <input id="menu-new-plots" type="number" min="1" max="32" placeholder="4" />
                </label>
              </div>
              <!-- Everything cut from here is said better by the thing it was
                   describing: each box's placeholder is its own default, and a
                   silly number is clamped rather than refused, so printing the
                   ranges was three limits nobody was going to hit. What is left
                   is the one fact no field can tell you — that these two are
                   asked once, because the building is stamped when you walk in. -->
              <p class="menu-note">Blank takes the number shown. Shelves and plots can only
                be chosen now — after that you build them yourself.</p>
              <div class="wacts">
                <button class="wplay" id="menu-create">Start it</button>
                <button class="wghost" id="menu-cancel">Cancel</button>
              </div>
            </div>`
          : '<button class="menu-add" id="menu-open-new">+ New shop</button>'}

        <p class="menu-foot">${this.busy ? 'Working…' : '&nbsp;'}</p>
      </div>`;

    this.root.scrollTop = scroll;
    this.wire();
  }

  wire() {
    const q = (sel) => this.root.querySelector(sel);

    q('#menu-open-new')?.addEventListener('click', () => { this.creating = true; this.render(); q('#menu-new-name')?.focus(); });
    q('#menu-cancel')?.addEventListener('click', () => { this.creating = false; this.render(); });
    q('#menu-create')?.addEventListener('click', () => this.create());

    // Enter anywhere in the new-shop form starts it. A form with a button you
    // have to aim at is a form people abandon — more so now it is five fields
    // deep and four of them are ones you were always going to skip.
    this.root.querySelectorAll('.menu-new input').forEach((el) => {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.create(); });
    });

    this.root.querySelectorAll('[data-play]').forEach((el) => {
      el.addEventListener('click', () => this.play(this.worlds[Number(el.dataset.play)]));
    });
    this.root.querySelectorAll('[data-pin]').forEach((el) => {
      el.addEventListener('click', () => this.togglePin(this.worlds[Number(el.dataset.pin)]));
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
