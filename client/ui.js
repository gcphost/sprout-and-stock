/**
 * HUD and menus.
 *
 * Plain DOM over the canvas — no framework. Everything is driven from the
 * server snapshot, so the UI automatically shows content that was added live
 * without a page reload.
 */

import { FIXTURES, FIXTURE_REFUND } from '../shared/build.js';
import { BUILD_TOOLS, SECTIONS, sectionById } from './sections.js';
import { Rail } from './rail.js';

/** How each kind of fixture shows up in its own menu. */
const FIXTURE_ICON = {
  shelf: '🗄', freezer: '🧊', checkout: '💳', plot: '🌱', station: '⚙️',
};

export class UI {
  constructor(net) {
    this.net = net;
    this.catalog = { items: [], crops: [], upgrades: [] };
    this.selectedCrop = null;
    this.buildOn = false;
    this.buildTool = 'shelf';
    this.buildRot = 0;
    this.buildCosts = {};
    this.el = {
      cash: document.getElementById('cash'),
      day: document.getElementById('day'),
      clock: document.getElementById('clock'),
      rep: document.getElementById('rep'),
      season: document.getElementById('season'),
      wheel: document.getElementById('wheel'),
      toast: document.getElementById('toast'),
      log: document.getElementById('log'),
      mods: document.getElementById('mods'),
      panel: document.getElementById('panel'),
      panelTitle: document.getElementById('panel-title'),
      panelBody: document.getElementById('panel-body'),
      carry: document.getElementById('carry'),
      build: document.getElementById('build'),
      buildTools: document.getElementById('build-tools'),
      buildHint: document.getElementById('build-hint'),
      prompt: document.getElementById('prompt'),
      rail: document.getElementById('rail'),
      search: document.getElementById('panel-search'),
      chips: document.getElementById('panel-tags'),
      filter: document.getElementById('panel-filter'),
    };
    // Touch devices don't have a mouse button to name, and "click" is wrong on
    // a phone. Decided once at boot rather than per frame.
    this.holdWord = matchMedia('(hover: none)').matches ? 'Hold' : 'Click &amp; hold';

    // Per-section, and wiped when the section closes — a filter you can't see
    // the cause of is worse than no filter at all.
    this.query = '';
    this.picked = new Set();

    this.rail = new Rail(this, this.el.rail);
    this.el.search.oninput = () => { this.query = this.el.search.value; this.paintSection(); };

    document.getElementById('panel-close').onclick = () => this.closePanel();
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.escape();
    });
    this.renderHotbar();
  }

  setCatalog(catalog) {
    this.catalog = catalog;
    this.buildCosts = catalog.buildCosts ?? this.buildCosts;
    if (!this.selectedCrop && catalog.crops[0]) this.selectCrop(catalog.crops[0].id);
    if (this.wheelOpen) this.renderWheel();
    this.renderHotbar();
    // If a section is open, redraw it so newly-added content appears instantly.
    // A fixture menu isn't a section and refreshes itself from the snapshot.
    if (this.openPanel && this.openPanel !== 'fixture') this.showSection(this.openPanel);
  }

  // ---- build mode ----------------------------------------------------------

  toggleBuild(on = !this.buildOn) {
    this.buildOn = on;
    this.buildRot = 0;
    document.body.classList.toggle('building', on);
    if (!on && this.openPanel === 'fixture') this.closePanel();
    this.net.send('build-mode', { on, tool: this.buildTool });
    this.renderHotbar();
    this.toast(on
      ? 'Build mode — tap anything you already own to open it, or tap bare ground to build'
      : 'Back to shopkeeping');
  }

  selectBuildTool(id) {
    if (!BUILD_TOOLS.some((t) => t.id === id)) return;
    this.buildTool = id;
    this.buildRot = 0;
    this._sentTool = id;
    this.net.send('build-tool', { tool: id });
    this.renderHotbar();
  }

  /**
   * The server owns the build tool, because it disarms Clear after a removal.
   * Adopt its value — but only once it has caught up with the last tool we
   * sent, or an in-flight snapshot would undo the button you just pressed.
   */
  syncBuildTool(serverTool) {
    if (!this.buildOn || !serverTool) return;
    if (this._sentTool && serverTool !== this._sentTool) return;
    this._sentTool = null;
    if (serverTool === this.buildTool) return;
    this.buildTool = serverTool;
    this.buildRot = 0;
    this.renderHotbar();
  }

  /** The fixture the ghost should be showing, or null when there isn't one. */
  ghostKindForTool() {
    if (!this.buildOn) return null;
    // What's in your hands outranks what's on the palette: while you're
    // carrying a shelf, every tile you point at is a candidate home for *it*.
    return this.holding?.kind ?? this.buildTool;
  }

  rotateBuild() {
    this.buildRot = (this.buildRot + 1) % 4;
  }

  /**
   * The bottom bar: the sub-icons for whatever is active.
   *
   * Fixtures while you're building, seeds while the seed menu is open, and
   * nothing at all otherwise — the shop floor is the game, and a toolbar that
   * never leaves makes it look like a level editor. It's also what makes 1–9
   * legible: the number on a button is the key that presses it.
   */
  renderHotbar() {
    if (!this.el.buildTools) return;
    const mode = this.buildOn ? 'build' : (this.openPanel === 'seeds' ? 'seeds' : null);
    this.el.build.classList.toggle('on', !!mode);
    if (!mode) return;

    const btn = (i, on, icon, name, note) => `
      <button class="tool ${on ? 'on' : ''}" data-slot="${i}">
        <span class="key">${i + 1}</span>
        <span class="ico">${icon}</span>
        <span class="nm">${name}</span>${note ? `<span class="cost">${note}</span>` : ''}
      </button>`;

    if (mode === 'build') {
      this.el.buildTools.innerHTML = BUILD_TOOLS.map((t, i) => {
        const cost = this.buildCosts[t.id];
        return btn(i, t.id === this.buildTool, t.icon, t.name, cost == null ? '' : `$${cost.toFixed(0)}`);
      }).join('')
        + `<button class="tool more" data-build-menu="1">
            <span class="key">M</span><span class="ico">☰</span><span class="nm">Menu</span>
          </button>`;
      this.el.buildTools.querySelector('[data-build-menu]').onclick = () => this.showSection('build');
    } else {
      this.el.buildTools.innerHTML = this.catalog.crops.slice(0, 9).map((c, i) => btn(
        i, c.id === this.selectedCrop, '🌱', c.name, `$${c.seed_cost.toFixed(2)}`,
      )).join('');
    }

    this.el.buildTools.querySelectorAll('[data-slot]').forEach((b) => {
      const i = Number(b.dataset.slot);
      b.onclick = () => (mode === 'build' ? this.selectBuildToolByIndex(i) : this.selectCropByIndex(i));
    });
    this.renderBuildHint(mode);
  }

  /**
   * The line under the bar. It has one thing to say at a time: what you're
   * carrying, what you're pointing at, or what a tap would do.
   */
  renderBuildHint(mode = this.buildOn ? 'build' : 'seeds') {
    if (!this.el.buildHint) return;
    if (mode === 'seeds') {
      const crop = this.catalog.crops.find((c) => c.id === this.selectedCrop);
      this.el.buildHint.textContent = crop
        ? `${crop.name} goes in the next plot you turn over`
        : 'pick what to plant next';
      return;
    }
    if (this.holding) {
      this.el.buildHint.textContent = `Carrying a ${this.holding.label.toLowerCase()} — tap a tile to set it down · R turns it · Esc puts it back`;
      return;
    }
    if (this.aimed) {
      this.el.buildHint.textContent = `${this.fixtureName(this.aimed)} — tap to open it`;
      return;
    }
    const tool = BUILD_TOOLS.find((t) => t.id === this.buildTool);
    this.el.buildHint.textContent = `tap bare ground to build a ${(tool?.name ?? 'fixture').toLowerCase()} · R rotates · tap anything you own to open its menu`;
  }

  /**
   * The fixture under the pointer, from the renderer. Only the hint changes —
   * the gold ring in the world is the renderer's job.
   */
  setAim(f) {
    if ((f?.id ?? null) === (this.aimed?.id ?? null)) return;
    this.aimed = f;
    if (this.buildOn) this.renderBuildHint('build');
  }

  /** "Shelf", "Freezer", "Blender" — what to call this fixture out loud. */
  fixtureName(f) {
    if (f.kind === 'station') {
      const words = String(f.station ?? 'appliance').replace(/-/g, ' ');
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
    return FIXTURES[f.kind]?.label ?? 'Fixture';
  }

  selectBuildToolByIndex(i) {
    const t = BUILD_TOOLS[i];
    if (t) this.selectBuildTool(t.id);
  }

  selectCropByIndex(i) {
    const c = this.catalog.crops[i];
    if (c) this.selectCrop(c.id);
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
    if (this.openPanel !== id) this.clearFilter();
    this.openPanel = id;
    this.fixtureRef = null;
    sec.onOpen?.(this);
    this._sectionKey = sec.live?.(this) ?? null;
    this.el.search.placeholder = `search ${sec.name.toLowerCase()}…`;
    this.rail.setOpen(id);
    this.paintSection();
    this.renderHotbar();
  }

  paintSection() {
    const sec = sectionById(this.openPanel);
    if (!sec) return;
    const all = sec.rows(this);
    // Search over four rows is noise, so the controls only appear once a list
    // is long enough to get lost in — and can't leave a filter behind when it
    // shrinks back under the line.
    const listable = all.filter((r) => !r.sep);
    const filterable = listable.length >= 8;
    if (!filterable && (this.query || this.picked.size)) this.clearFilter();

    const rows = filterable ? this.applyFilter(all) : all;
    const body = rows.length
      ? rows.map((r, i) => this.rowHtml(r, i)).join('')
      : '<div class="foot">Nothing matches that.</div>';

    this.showPanel(sec.title, body + (sec.foot ? `<div class="foot">${sec.foot(this)}</div>` : ''));
    this.el.filter.hidden = !filterable;
    if (filterable) this.renderChips(listable, sec);
    this.wireRows(rows);
  }

  applyFilter(rows) {
    const q = this.query.trim().toLowerCase();
    if (!q && !this.picked.size) return rows;
    return rows.filter((r) => {
      // A heading with everything under it filtered away is a heading over
      // nothing, so headings only survive an unfiltered list.
      if (r.sep) return false;
      if (this.picked.size && !(r.facets ?? []).some((f) => this.picked.has(f))) return false;
      if (!q) return true;
      return `${r.name} ${r.sub ?? ''} ${(r.facets ?? []).join(' ')}`.toLowerCase().includes(q);
    });
  }

  clearFilter() {
    this.query = '';
    this.picked.clear();
    this.el.search.value = '';
  }

  rowHtml(r, i) {
    if (r.sep) return `<div class="sep">${r.sep}</div>`;
    const cls = ['row', 'sec-row'];
    if (r.picked) cls.push('picked');
    if (r.dim) cls.push('owned');
    if (r.run) cls.push('clickable');
    return `<div class="${cls.join(' ')}"${r.run ? ` data-row="${i}"` : ''}>
      ${r.hot ? `<span class="hot">${r.hot}</span>` : ''}
      ${r.icon ? `<span class="bico">${r.icon}</span>` : ''}
      <div class="name">${r.name}${r.own ? ` <span class="own">${r.own}</span>` : ''}${
  r.sub ? `<span class="tags">${r.sub}</span>` : ''}</div>
      ${r.right ? `<div class="price">${r.right}</div>` : ''}
      ${r.button ? `<button data-btn="${i}">${r.button.label}</button>` : ''}
      ${r.tail ? `<span class="have">${r.tail}</span>` : ''}
    </div>`;
  }

  wireRows(rows) {
    this.el.panelBody.querySelectorAll('[data-row]').forEach((el) => {
      el.onclick = () => rows[Number(el.dataset.row)]?.run?.(this);
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

  /** Chips for whatever the rows actually carry, not the whole vocabulary. */
  renderChips(rows, sec) {
    if (!sec.facet) { this.el.chips.innerHTML = ''; return; }
    const seen = [...new Set(rows.flatMap((r) => r.facets ?? []))].sort();
    this.el.chips.innerHTML = seen
      .map((f) => `<button class="chip ${this.picked.has(f) ? 'on' : ''}" data-chip="${f}">${f}</button>`)
      .join('');
    this.el.chips.querySelectorAll('[data-chip]').forEach((b) => {
      b.onclick = () => {
        const f = b.dataset.chip;
        if (this.picked.has(f)) this.picked.delete(f);
        else this.picked.add(f);
        this.paintSection();
      };
    });
  }

  // ---- one menu per fixture -------------------------------------------------
  //
  // Tapping a shelf opens that shelf. Not "the nearest shelf", not "a shelf" —
  // the one you tapped, named by id, which is the whole reason moving things
  // used to grab the wrong one. Everything a fixture can do lives here, so the
  // list is allowed to be different for a freezer than for a plot.

  /**
   * Open the menu for one fixture.
   *
   * @param {object} f a layout record: { id, kind, x, z, rot, station }
   */
  showFixture(f) {
    if (!f) return;
    this.openPanel = 'fixture';
    // The whole layout record is kept, not just its id: turning something
    // re-mints its id (it becomes a fresh placement), and the menu should stay
    // open on the thing that is still sitting right there on that tile.
    this.fixtureRef = f;

    const live = this.liveFixture(f);
    this._fxMenuKey = this.fixtureSignature(f, live);
    const kind = f.kind;
    const rotates = !!FIXTURES[kind]?.rotates;
    const refund = this.refundFor(f);
    const blocked = this.removeBlockedReason(f, live);

    const act = (id, icon, name, sub, { danger = false, off = false, right = '' } = {}) => `
      <div class="row fx-act ${off ? 'off' : ''} ${danger ? 'danger' : ''}" ${off ? '' : `data-act="${id}"`}>
        <span class="bico">${icon}</span>
        <div class="name">${name}<span class="tags">${sub}</span></div>
        <div class="price">${right}</div>
      </div>`;

    const parts = [this.fixtureDetail(f, live)];

    parts.push('<div class="sep">Do something with it</div>');
    parts.push(act('move', '🖐', 'Move it',
      'Picks it up with everything on it. Tap where you want it — nothing shifts until you do.'));
    if (rotates) {
      // Which side a thing faces means something different for each of them,
      // and it's the reason to turn it at all — so say the actual reason.
      const why = {
        checkout: 'A quarter turn. Decides where you stand to serve, and which way the queue runs.',
        station: 'A quarter turn. Decides which side you load it from.',
      }[kind] ?? 'A quarter turn. Decides which aisle shoppers browse it from.';
      parts.push(act('rotate', '🔄', 'Turn it round', why));
    }
    const holds = this.contentsOf(f, live);
    if (holds.n > 0) {
      parts.push(act('empty', '🧹', 'Empty it', holds.blurb, { right: `${holds.n}` }));
    } else if ((kind === 'shelf' || kind === 'freezer') && live?.item_id) {
      parts.push(act('empty', '🏷', 'Take the label off',
        `It is empty but still reserved for ${this.itemName(live.item_id)}. Clear it and anything can go on it.`));
    }
    parts.push(act('remove', '🗑', kind === 'station' ? 'Sell it back' : 'Remove it',
      blocked ?? 'Takes it out of the shop and gives you half of what it cost back.',
      { danger: true, off: !!blocked, right: blocked ? '' : `+$${refund.toFixed(2)}` }));

    parts.push(this.fixtureUpgrades(f));

    this.showPanel(`${FIXTURE_ICON[kind] ?? '📦'} ${this.fixtureName(f)}`, parts.join(''));
    this.wireFixtureMenu(f, live);
  }

  /** The read-out at the top: what this particular thing is doing right now. */
  fixtureDetail(f, live) {
    const line = (label, value) => `<div class="fx-line"><span>${label}</span><b>${value}</b></div>`;

    if (f.kind === 'shelf' || f.kind === 'freezer') {
      const item = live?.item_id ? this.itemById(live.item_id) : null;
      const cap = item?.stack ?? null;
      return `<div class="fx-detail">
        ${line('Holding', item ? item.name : '<i>nothing</i>')}
        ${line('Stock', cap ? `${live.qty} / ${cap}` : `${live?.qty ?? 0}`)}
        ${item ? `<div class="fx-price">
          <span>Price</span>
          <button data-price="-1">−</button>
          <b>$${(live.price ?? 0).toFixed(2)}</b>
          <button data-price="1">+</button>
        </div>` : ''}
      </div>`;
    }

    if (f.kind === 'plot') {
      const crop = live?.crop_id ? this.catalog.crops.find((c) => c.id === live.crop_id) : null;
      return `<div class="fx-detail">
        ${line('Soil', live?.soil === 'tilled' ? 'turned over, ready' : 'rough — needs tilling')}
        ${line('Growing', crop ? crop.name : '<i>nothing</i>')}
        ${crop ? line('Ready', live.ready ? 'yes — go and pick it' : `${Math.round((live.growth ?? 0) * 100)}%`) : ''}
      </div>`;
    }

    if (f.kind === 'checkout') {
      const q = this.state?.queues?.find((c) => c.id === f.id);
      // How long a line it can take is the thing worth knowing before you turn
      // it: past that, shoppers pile up on the last slot instead of queueing.
      return `<div class="fx-detail">
        ${line('Queue', `${q?.queue ?? 0} waiting`)}
        ${line('Room for', `${f.queueMax ?? 0} in the line`)}
      </div>`;
    }

    if (f.kind === 'station') {
      const inside = Object.entries(live?.contents ?? {})
        .map(([id, n]) => `${n}× ${this.itemName(id)}`).join(', ');
      const makes = (this.catalog.recipes ?? [])
        .filter((r) => r.station === f.station)
        .map((r) => r.name).join(', ');
      return `<div class="fx-detail">
        ${line('In the hopper', inside || '<i>empty</i>')}
        ${line('Making', live?.making ? this.itemName(live.output?.item_id ?? live.making) : '<i>idle</i>')}
        ${line('Can make', makes || '<i>no recipes yet</i>')}
      </div>`;
    }
    return '';
  }

  /** Upgrades that add more of this kind of thing — bought right from here. */
  fixtureUpgrades(f) {
    const owned = this.ownedUpgrades ?? [];
    const relevant = (this.catalog.upgrades ?? [])
      .filter((u) => u.kind === f.kind && !owned.includes(u.id));
    if (!relevant.length) return '';
    return '<div class="sep">More of these</div>'
      + relevant.map((u) => `
        <div class="row">
          <div class="name">${u.name}<span class="tags">${u.description}</span></div>
          <div class="price">$${u.cost.toFixed(0)}</div>
          <button data-up="${u.id}">buy</button>
        </div>`).join('');
  }

  wireFixtureMenu(f, live) {
    const send = (type, payload) => this.net.send(type, payload);

    this.el.panelBody.querySelectorAll('[data-act]').forEach((el) => {
      el.onclick = () => {
        const act = el.dataset.act;
        if (act === 'move') {
          send('build-lift', { id: f.id });
          this.closePanel();
          this.toast(`Carrying the ${this.fixtureName(f).toLowerCase()} — tap where it should go`);
        } else if (act === 'rotate') {
          send('build-rotate', { id: f.id, dir: 1 });
        } else if (act === 'empty') {
          send('build-empty', { id: f.id });
        } else if (act === 'remove') {
          send('build-remove', { id: f.id });
          this.closePanel();
        }
      };
    });

    this.el.panelBody.querySelectorAll('[data-price]').forEach((el) => {
      el.onclick = () => {
        const step = Number(el.dataset.price) * 0.25;
        const next = Math.max(0, Math.round(((live?.price ?? 0) + step) * 100) / 100);
        send('set-price', { shelfId: f.id, price: next });
      };
    });

    this.el.panelBody.querySelectorAll('[data-up]').forEach((el) => {
      el.onclick = () => send('buy-upgrade', { upgradeId: el.dataset.up });
    });
  }

  /** The live snapshot row for a fixture — its stock, crop or hopper. */
  liveFixture(f) {
    const s = this.state;
    if (!s) return null;
    if (f.kind === 'shelf' || f.kind === 'freezer') return s.shelves?.find((x) => x.id === f.id) ?? null;
    if (f.kind === 'plot') return s.plots?.find((x) => x.id === f.id) ?? null;
    if (f.kind === 'station') return s.stations?.find((x) => x.id === f.id) ?? null;
    if (f.kind === 'checkout') return s.queues?.find((x) => x.id === f.id) ?? null;
    return null;
  }

  /** What "empty it" would tip out, and how to describe it. */
  contentsOf(f, live) {
    if (f.kind === 'shelf' || f.kind === 'freezer') {
      const n = live?.qty ?? 0;
      return { n, blurb: n ? `Puts ${n}× ${this.itemName(live.item_id)} in a crate on the floor beside it.` : '' };
    }
    if (f.kind === 'station') {
      const n = Object.values(live?.contents ?? {}).reduce((a, b) => a + b, 0) + (live?.output?.qty ?? 0);
      return { n, blurb: 'Tips the hopper out into crates. A batch already going is left to finish.' };
    }
    if (f.kind === 'plot') {
      const n = live?.crop_id ? 1 : 0;
      return { n, blurb: 'Pulls the crop out and leaves the bed rough. A half-grown crop is lost.' };
    }
    return { n: 0, blurb: '' };
  }

  /** Why Remove is greyed out, or null if it isn't. */
  removeBlockedReason(f, live) {
    if (this.contentsOf(f, live).n > 0) return 'Empty it first — nothing gets binned by accident.';
    if (f.kind === 'checkout' && (this.state?.queues?.length ?? 0) <= 1) {
      return 'This is your only till. You need one to take money.';
    }
    return null;
  }

  /**
   * What tearing this out pays. The same fraction the server uses, imported
   * from `shared/build.js` — a button that promises a different number to the
   * one you get is worse than no number at all.
   */
  refundFor(f) {
    if (f.kind === 'station') {
      const up = (this.catalog.upgrades ?? []).find((u) => u.kind === 'station'
        && u.payload?.station === f.station && (this.ownedUpgrades ?? []).includes(u.id));
      return (up?.cost ?? 0) * FIXTURE_REFUND;
    }
    return (this.buildCosts[f.kind] ?? 0) * FIXTURE_REFUND;
  }

  /** Everything the open menu draws from, so it can redraw when any of it moves. */
  fixtureSignature(f, live) {
    return JSON.stringify([f.id, f.rot, live, this.state?.cash?.toFixed(0), this.ownedUpgrades?.length]);
  }

  itemById(id) { return this.catalog.items.find((i) => i.id === id) ?? null; }
  itemName(id) { return this.itemById(id)?.name ?? id ?? 'something'; }

  /**
   * Keep the open fixture menu honest.
   *
   * Called with the fresh layout after any re-flow. A fixture that was turned
   * has a new id on the same tile, so follow it there; one that was removed is
   * gone and the menu goes with it.
   */
  refreshFixture(fixtures) {
    if (this.openPanel !== 'fixture' || !this.fixtureRef) return;
    const at = this.fixtureRef;
    // Tile first, id second — and that order is load-bearing. The generator
    // mints `shelf-p0`, `shelf-p1`… positionally and re-mints them on every
    // re-flow, so turning a procedural shelf both gives it a new `fx-N` id and
    // frees its old name for a completely different shelf. Looking up by id
    // would quietly re-point this menu at that other shelf, which is the exact
    // bug this whole screen exists to kill.
    const found = fixtures.find((f) => f.x === at.x && f.z === at.z && f.kind === at.kind)
      ?? fixtures.find((f) => f.id === at.id);
    if (!found) { this.closePanel(); return; }
    this.showFixture(found);
  }

  /**
   * The seed wheel: hold to open, sweep to the segment you want, release.
   *
   * A permanent bar is clutter you read every frame and use once a minute, and
   * a popover anchored to a plot fights the camera. A wheel costs no screen
   * space at rest and becomes muscle memory — the same reason action games use
   * one for weapons.
   */
  openWheel(cx, cy) {
    const crops = this.catalog.crops;
    if (!crops.length) return;
    this.wheelOpen = true;
    this.wheelCentre = { x: cx, y: cy };
    this.wheelHot = crops.findIndex((c) => c.id === this.selectedCrop);
    this.renderWheel();
    this.el.wheel.classList.add('on');
  }

  closeWheel(commit = true) {
    if (!this.wheelOpen) return;
    this.wheelOpen = false;
    this.el.wheel.classList.remove('on');
    const crop = this.catalog.crops[this.wheelHot];
    if (commit && crop) this.selectCrop(crop.id);
  }

  /** Point the wheel at whatever direction the pointer is from its centre. */
  aimWheel(px, py) {
    if (!this.wheelOpen) return;
    const crops = this.catalog.crops;
    const dx = px - this.wheelCentre.x;
    const dy = py - this.wheelCentre.y;
    // Inside the hub means "keep what I had" — a flick has to travel to count.
    if (Math.hypot(dx, dy) < 44) { this.wheelHot = -1; this.paintWheel(); return; }
    const a = (Math.atan2(dy, dx) + Math.PI * 2.5) % (Math.PI * 2);
    this.wheelHot = Math.floor((a / (Math.PI * 2)) * crops.length) % crops.length;
    this.paintWheel();
  }

  renderWheel() {
    const crops = this.catalog.crops;
    const R = 132, r = 44;
    const { x: cx, y: cy } = this.wheelCentre;
    const step = (Math.PI * 2) / crops.length;

    const arc = (i) => {
      const a0 = -Math.PI / 2 + i * step;
      const a1 = a0 + step;
      const p = (rad, ang) => `${cx + Math.cos(ang) * rad} ${cy + Math.sin(ang) * rad}`;
      const big = step > Math.PI ? 1 : 0;
      return `M ${p(r, a0)} L ${p(R, a0)} A ${R} ${R} 0 ${big} 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 ${big} 0 ${p(r, a0)} Z`;
    };

    const segs = crops.map((crop, i) => {
      const mid = -Math.PI / 2 + (i + 0.5) * step;
      const lx = cx + Math.cos(mid) * ((R + r) / 2);
      const ly = cy + Math.sin(mid) * ((R + r) / 2);
      return `<path class="seg" data-i="${i}" d="${arc(i)}"></path>
        <text class="lbl" x="${lx}" y="${ly - 7}">${crop.name}</text>
        <text class="lbl sub" x="${lx}" y="${ly + 10}">$${crop.seed_cost.toFixed(2)}</text>`;
    }).join('');

    this.el.wheel.innerHTML = `<svg width="100%" height="100%">
      ${segs}
      <circle class="hub" cx="${cx}" cy="${cy}" r="${r - 6}"></circle>
      <text class="hublbl" x="${cx}" y="${cy}">seeds</text>
    </svg>`;
    this.paintWheel();
  }

  /** Highlight the aimed segment and grey out what can't be planted now. */
  paintWheel() {
    const segs = this.el.wheel.querySelectorAll('.seg');
    segs.forEach((seg, i) => {
      const crop = this.catalog.crops[i];
      const inSeason = !crop.seasons?.length || crop.seasons.includes(this._season);
      const affordable = (this._cash ?? 0) >= crop.seed_cost;
      seg.classList.toggle('off', !inSeason || !affordable);
      seg.classList.toggle('hot', i === this.wheelHot);
    });
  }

  selectCrop(id) {
    this.selectedCrop = id;
    // The server plants from its own copy — the wheel only chooses.
    this.net.send('select-crop', { cropId: id });
  }

  update(state) {
    // The fixture menu reads stock, queues and hoppers straight out of here.
    this.state = state;
    this.el.cash.textContent = `$${state.cash.toFixed(2)}`;
    this.el.day.textContent = `Day ${state.day}`;
    this.el.season.textContent = state.season;
    this.el.rep.style.width = `${Math.round(state.reputation * 100)}%`;

    const hour = state.time * 24;
    const h = Math.floor(hour);
    const m = Math.floor((hour - h) * 60);
    this.el.clock.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    this.el.clock.classList.toggle('shut', !state.isOpen);

    const me = state.players.find((p) => p.id === this.net.myId);
    this.el.carry.textContent = me?.carry
      ? `carrying ${me.carry.qty}x ${me.carry.item_id}`
      : '';
    this.updatePrompt(me?.action ?? null);
    this.ownedUpgrades = state.ownedUpgrades ?? this.ownedUpgrades;
    // The build menu shows how many of each you own. Keeping it here rather
    // than only in the section means the rail's badges can read it too.
    this.fixtureCounts = state.fixtures ?? this.fixtureCounts;

    // An open fixture menu is a live window onto one thing: stock going down,
    // a crop ripening, a queue forming. Redrawn only when what it shows has
    // actually changed, not ten times a second.
    if (this.openPanel === 'fixture' && this.fixtureRef) {
      // Re-read the tile rather than trusting the record we opened with, for
      // the same reason `refreshFixture` does — see the note there.
      const f = this.scene?.fixtureAt(this.fixtureRef.x, this.fixtureRef.z) ?? null;
      if (!f) this.closePanel();
      else if (this.fixtureSignature(f, this.liveFixture(f)) !== this._fxMenuKey) this.showFixture(f);
    }

    // A lifted fixture changes what the ghost is and what the hint says, so the
    // bar has to follow the server's idea of what's in your hands, not ours.
    const heldId = me?.holding?.id ?? null;
    if (heldId !== this._heldId) {
      this._heldId = heldId;
      this.holding = me?.holding ?? null;
      this.buildRot = this.holding?.rot ?? this.buildRot;
      this.renderHotbar();
    }
    this.syncBuildTool(me?.build);

    this.el.mods.innerHTML = state.modifiers
      .map((m) => `<span class="mod ${m.demand_mult >= 1 ? 'up' : 'down'}">${m.tag} ×${m.demand_mult}</span>`)
      .join('');

    // The wheel and the sections read these when they paint, so keep them
    // fresh — and set them before anything asks a section to redraw.
    this._season = state.season;
    this._cash = state.cash;
    if (this.wheelOpen) this.paintWheel();

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
   * "Click & hold to Harvest", pinned under the HUD.
   *
   * Being in range no longer does anything on its own, so the game has to say
   * out loud that there's something here and that holding is what does it —
   * otherwise standing next to a ripe plot just looks broken.
   */
  updatePrompt(action) {
    const key = action ? `${action.kind}:${action.target}:${action.holding}` : null;
    if (key === this._promptKey) return;
    this._promptKey = key;

    if (!action) {
      this.el.prompt.className = 'hud';
      return;
    }
    this.el.prompt.innerHTML = action.holding
      ? `<b>${action.label}…</b>`
      : `<span class="hk">${this.holdWord}</span> to <b>${action.label}</b>`;
    // Keep `hud` — it carries position:fixed, and dropping it drops the
    // element out of the overlay and into the document flow, invisible.
    this.el.prompt.className = `hud show${action.holding ? ' going' : ''}`;
  }

  pushLog(msg) {
    const line = document.createElement('div');
    line.textContent = msg;
    this.el.log.prepend(line);
    while (this.el.log.children.length > 6) this.el.log.lastChild.remove();
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
    this.fixtureRef = null;
    this.el.panel.classList.remove('show');
    this.el.filter.hidden = true;
    this.clearFilter();
    this.rail.setOpen(null);
    // The seed hotbar belongs to the seed menu and leaves with it.
    this.renderHotbar();
  }

  /**
   * One press, one layer. What you typed, then an open menu, then the fixture
   * in your hands, then build mode itself — so Escape never quits building when
   * all you wanted was to clear a search box.
   */
  escape() {
    if (this.openPanel && this.query) { this.clearFilter(); this.paintSection(); return; }
    if (this.openPanel) { this.closePanel(); return; }
    if (!this.buildOn) return;
    if (this.holding) { this.net.send('build-cancel', {}); return; }
    this.toggleBuild(false);
  }

  showPanel(title, html) {
    this.el.panelTitle.textContent = title;
    this.el.panelBody.innerHTML = html;
    this.el.panel.classList.add('show');
  }
}
