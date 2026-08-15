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

  async act(fn) {
    if (this.busy) return;
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
    const name = this.root.querySelector('#menu-new-name')?.value.trim() ?? '';
    const seed = this.root.querySelector('#menu-new-seed')?.value.trim() ?? '';
    await this.act(async () => {
      const { world } = await api('POST', '/worlds', { name, seed });
      this.play(world);
    });
  }

  /**
   * Deleting asks first, and asks with the name in the question.
   *
   * The sweeper can take an unpinned world that has sat for a fortnight, which
   * makes this the one place a shop disappears *immediately* — and the row it
   * sits on is two rows from Play.
   */
  async remove(world) {
    const sure = confirm(
      `Delete "${world.name}"?\n\n`
      + `Day ${world.day}, ${money(world.cash)}, ${world.upgrades} upgrade(s), ${world.staff} staff.\n\n`
      + 'This cannot be undone. Items, crops and everything else you have made are shared '
      + 'between shops and are not deleted.',
    );
    if (!sure) return;
    await this.act(() => api('DELETE', `/worlds/${encodeURIComponent(world.id)}`));
  }

  async togglePin(world) {
    await this.act(() => api('PATCH', `/worlds/${encodeURIComponent(world.id)}`, { pinned: !world.pinned }));
  }

  // ---- drawing ------------------------------------------------------------

  card(w, i) {
    const last = localStorage.getItem(REMEMBERED) === w.id;
    return `
      <div class="wcard${last ? ' last' : ''}">
        <div class="wtop">
          <div class="wname">${esc(w.name)}</div>
          ${w.live ? `<span class="wlive">${w.players
            ? `${w.players} playing`
            : 'open'}</span>` : ''}
        </div>
        <div class="wstats">
          <b>Day ${w.day}</b><span>${money(w.cash)}</span><span>${esc(w.season)}</span>
        </div>
        <div class="wsub">
          ${w.upgrades} upgrade${w.upgrades === 1 ? '' : 's'} ·
          ${w.staff} staff · played ${ago(w.played_at)}
          ${w.pinned ? ' · kept' : ''}
        </div>
        <div class="wacts">
          <button class="wplay" data-play="${i}">${w.live ? 'Join' : 'Play'}</button>
          <button class="wghost" data-pin="${i}" title="${w.pinned
            ? 'Kept — never cleaned up automatically'
            : 'Keep this shop, whatever happens'}">${w.pinned ? 'Kept' : 'Keep'}</button>
          <button class="wghost wdel" data-del="${i}">Delete</button>
        </div>
      </div>`;
  }

  render() {
    const name = localStorage.getItem('sns-name') ?? '';
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
                <input id="menu-new-name" maxlength="32" placeholder="Berry's" />
              </label>
              <label class="menu-field">
                <span>Seed</span>
                <input id="menu-new-seed" maxlength="24" placeholder="leave blank for a surprise" />
              </label>
              <p class="menu-note">The seed decides the shape of the building and the fields.
                Everything you and your agents have made — items, crops, customers, fixtures —
                is shared with every shop.</p>
              <div class="wacts">
                <button class="wplay" id="menu-create">Start it</button>
                <button class="wghost" id="menu-cancel">Cancel</button>
              </div>
            </div>`
          : '<button class="menu-add" id="menu-open-new">+ New shop</button>'}

        <p class="menu-foot">${this.busy ? 'Working…' : '&nbsp;'}</p>
      </div>`;

    this.wire();
  }

  wire() {
    const q = (sel) => this.root.querySelector(sel);

    q('#menu-open-new')?.addEventListener('click', () => { this.creating = true; this.render(); q('#menu-new-name')?.focus(); });
    q('#menu-cancel')?.addEventListener('click', () => { this.creating = false; this.render(); });
    q('#menu-create')?.addEventListener('click', () => this.create());

    // Enter anywhere in the new-shop form starts it. A two-field form with a
    // button you have to aim at is a form people abandon.
    this.root.querySelectorAll('#menu-new-name, #menu-new-seed').forEach((el) => {
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
