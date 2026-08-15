/**
 * HUD and menus.
 *
 * Plain DOM over the canvas — no framework. Everything is driven from the
 * server snapshot, so the UI automatically shows content that was added live
 * without a page reload.
 */

import { FIXTURES } from '../shared/build.js';
import { BUILD_TOOLS, SECTIONS, sectionById } from './sections.js';
import { Rail } from './rail.js';
import { ICONS } from './icons.js';
import { showFixture } from './fixture-menu.js';

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
    if (r.sep && r.icon) { groups.push({ label: r.sep, icon: r.icon, rows: [] }); continue; }
    if (!groups.length) { groups.lead.push(r); continue; }
    groups[groups.length - 1].rows.push(r);
  }
  return groups.length >= 2 ? groups : null;
}

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
    this.buildOn = false;
    this.buildTool = 'shelf';
    this.buildVariant = '';
    this.buildRot = 0;
    this.buildCosts = {};
    this.el = {
      cash: document.getElementById('cash'),
      day: document.getElementById('day'),
      clock: document.getElementById('clock'),
      rep: document.getElementById('rep'),
      season: document.getElementById('season'),
      toast: document.getElementById('toast'),
      log: document.getElementById('log'),
      mods: document.getElementById('mods'),
      todo: document.getElementById('todo'),
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
      filter: document.getElementById('panel-filter'),
    };
    // Touch devices don't have a mouse button to name, and "click" is wrong on
    // a phone. Decided once at boot rather than per frame.
    this.holdWord = matchMedia('(hover: none)').matches ? 'Hold' : 'Click &amp; hold';

    // Per-section, and wiped when the section closes — a filter you can't see
    // the cause of is worse than no filter at all.
    this.query = '';

    this.rail = new Rail(this, this.el.rail);
    document.getElementById('search-icon').innerHTML = ICONS.search;
    this.el.search.oninput = () => { this.query = this.el.search.value; this.paintSection(); };

    const close = document.getElementById('panel-close');
    close.innerHTML = ICONS.close;
    close.onclick = () => this.closePanel();
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.escape();
    });
    this.renderHotbar();
  }

  setCatalog(catalog) {
    this.catalog = catalog;
    this.buildCosts = catalog.buildCosts ?? this.buildCosts;
    if (!this.selectedCrop && catalog.crops[0]) this.selectCrop(catalog.crops[0].id);
    this.renderHotbar();
    // If a section is open, redraw it so newly-added content appears instantly.
    // A fixture menu isn't a section and refreshes itself from the snapshot.
    if (this.openPanel && this.openPanel !== 'fixture') this.showSection(this.openPanel);
  }

  // ---- build mode ----------------------------------------------------------

  toggleBuild(on = !this.buildOn, { quiet = false } = {}) {
    this.buildOn = on;
    this.buildRot = 0;
    document.body.classList.toggle('building', on);
    if (!on && this.openPanel === 'fixture') this.closePanel();
    this.net.send('build-mode', { on, tool: this.buildTool });
    this.renderHotbar();
    // `quiet` is for a mode a button switched on around one action of its own:
    // the fixture visibly turning is the feedback, and announcing a mode change
    // either side of it says twice as much as happened.
    if (quiet) return;
    this.toast(on
      ? 'Build mode — tap anything you already own to open it, or tap bare ground to build'
      : 'Back to shopkeeping');
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
  startMove(f) {
    this._move = { kind: f.kind, borrowed: !!this._modeFromMenu, to: null };
    // `holding` isn't true until the next snapshot lands, and the menu is about
    // to close in front of it. Without a marker for that gap `releaseMenuMode`
    // hands the mode back mid-lift, and the server drops what you picked up.
    this._lifting = true;
  }

  /** Where the drop is aimed, so the errand can find the fixture afterwards. */
  markMoveTarget(tile) {
    this._move = { ...(this._move ?? { borrowed: false }), to: { x: tile.x, z: tile.z } };
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
    if (f) showFixture(this, f);
  }

  selectBuildTool(id) {
    if (!BUILD_TOOLS.some((t) => t.id === id)) return;
    this.buildTool = id;
    this.buildRot = 0;
    // Shapes belong to a kind, so switching kind drops back to Standard rather
    // than asking for a "corner till" nobody drew.
    this.buildVariant = '';
    this._sentTool = id;
    this.net.send('build-tool', { tool: id });
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
    this.renderBuildHint();
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
   * Only while you're building — the shop floor is the game, and a toolbar that
   * never leaves makes it look like a level editor. It's also what makes 1–9
   * legible: the number on a button is the key that presses it.
   */
  renderHotbar() {
    if (!this.el.buildTools) return;
    this.el.build.classList.toggle('on', this.buildOn);
    if (!this.buildOn) return;

    this.el.buildTools.innerHTML = BUILD_TOOLS.map((t, i) => {
      const cost = this.buildCosts[t.id];
      return `<button class="tool ${t.id === this.buildTool ? 'on' : ''}" data-slot="${i}">
          <span class="key">${i + 1}</span>
          <span class="ico">${t.icon}</span>
          <span class="nm">${t.name}</span>${cost == null ? '' : `<span class="cost">$${cost.toFixed(0)}</span>`}
        </button>`;
    }).join('')
      + `<button class="tool more" data-build-menu="1">
          <span class="key">M</span><span class="ico">☰</span><span class="nm">Menu</span>
        </button>`;

    this.el.buildTools.querySelector('[data-build-menu]').onclick = () => this.showSection('build');
    this.el.buildTools.querySelectorAll('[data-slot]').forEach((b) => {
      b.onclick = () => this.selectBuildToolByIndex(Number(b.dataset.slot));
    });
    this.renderBuildHint();
  }

  /**
   * The line under the bar. It has one thing to say at a time: what you're
   * carrying, what you're pointing at, or what a tap would do.
   */
  renderBuildHint() {
    if (!this.el.buildHint) return;
    if (this.holding) {
      this.el.buildHint.textContent = `Carrying a ${this.holding.label.toLowerCase()} — tap a tile to set it down · R turns it · Esc puts it back`;
      return;
    }
    if (this.aimed) {
      this.el.buildHint.textContent = `${this.fixtureName(this.aimed)} — tap to open it`;
      return;
    }
    // An amber ghost means it will land and cost you something. Saying what,
    // before the tap rather than after it, is the whole point of the colour.
    if (this.buildWarn) {
      this.el.buildHint.textContent = `${this.buildWarn} — tap anyway if you meant it · R rotates`;
      return;
    }
    const tool = BUILD_TOOLS.find((t) => t.id === this.buildTool);
    // Naming the shape matters more than naming the kind: picking one is the
    // only build setting with no icon lit up on the bar to remind you of it.
    const shape = this.buildVariantName();
    const what = shape ? `${shape.toLowerCase()} ${(tool?.name ?? 'fixture').toLowerCase()}` : (tool?.name ?? 'fixture').toLowerCase();
    this.el.buildHint.textContent = `tap bare ground to build a ${what} · R rotates · tap anything you own to open its menu`;
  }

  /**
   * What the tile under the pointer would cost you, or null if it's clean.
   * Set from the ghost's own verdict, so the words and the colour can never
   * disagree about what is about to happen.
   */
  setBuildWarn(warn) {
    if ((warn ?? null) === (this.buildWarn ?? null)) return;
    this.buildWarn = warn ?? null;
    if (this.buildOn) this.renderBuildHint();
  }

  /** The chosen shape's name, or '' when it's just the standard one. */
  buildVariantName() {
    if (!this.buildVariant) return '';
    const kind = this.catalog.fixtures?.find((f) => f.id === this.buildTool);
    return (kind?.variants ?? []).find((v) => v.id === this.buildVariant)?.name ?? '';
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
    if (this.openPanel !== id) { this.releaseMenuMode(); this.clearFilter(); this.tab = 0; }
    this.openPanel = id;
    this.fixtureRef = null;
    this.workerRef = null;
    this.panelTick = null;
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
    if (groups) {
      const at = Math.min(this.tab ?? 0, groups.length - 1);
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

    this.showPanel(sec.title, tabs + body + (sec.foot ? `<div class="foot">${sec.foot(this)}</div>` : ''));
    this.el.filter.hidden = !filterable;
    this.wireRows(rows);
    this.el.panelBody.querySelectorAll('[data-tab]').forEach((el) => {
      el.onclick = () => { this.tab = Number(el.dataset.tab); this.paintSection(); };
    });
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
   * One row.
   *
   * The icon and what the thing costs share one narrow column down the left,
   * because a price sitting out on the right reserves a whole column of width
   * for four characters and pushes every name into a second line. A plain
   * readout keeps its value on the right — there is no icon to stack it under
   * and the labels want to line up.
   *
   * The description wraps but is clamped to two lines and repeated in `title`,
   * so a row stays bounded whatever the copy says and the rest is a hover away.
   */
  rowHtml(r, i) {
    if (r.sep) return `<div class="sep">${r.sep}</div>`;
    const cls = ['row', 'sec-row'];
    if (r.picked) cls.push('picked');
    if (r.dim) cls.push('owned');
    if (r.run) cls.push('clickable');
    const stacked = !r.plain;
    return `<div class="${cls.join(' ')}"${r.run ? ` data-row="${i}"` : ''}${
  r.sub ? ` title="${r.sub.replace(/"/g, '&quot;')}"` : ''}>
      ${stacked && (r.icon || r.right) ? `<div class="lead">
        ${r.icon ? `<span class="bico">${r.icon}</span>` : ''}
        ${r.right ? `<span class="cost">${r.right}</span>` : ''}
      </div>` : ''}
      <div class="name">${r.name}${r.sub ? `<span class="tags">${r.sub}</span>` : ''}</div>
      ${!stacked && r.right ? `<div class="price">${r.right}</div>` : ''}
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

  /** Item lookups, used by every menu that names one. */
  itemById(id) { return this.catalog.items.find((i) => i.id === id) ?? null; }
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

    // Only tags you're actually failing to serve. A hot tag you already have
    // three shelves of isn't news, it's just the day going well.
    const stocked = new Set();
    for (const s of shelves) {
      if (!s.qty) continue;
      for (const tag of this.itemById(s.item_id)?.tags ?? []) stocked.add(tag);
    }
    const missed = (state.modifiers ?? [])
      .filter((m) => m.demand_mult >= 1.5 && !stocked.has(m.tag))
      .sort((a, b) => b.demand_mult - a.demand_mult)[0];
    if (missed) {
      out.push({
        icon: 'supplier', hot: true,
        text: `Get <b>${esc(missed.tag)}</b> in — wanted ×${missed.demand_mult}`,
      });
    }

    const ready = plots.filter((p) => p.ready).length;
    if (ready) out.push({ icon: 'plot', text: `<b>${ready}</b> ready to harvest` });

    const bare = shelves.filter((s) => !s.qty).length;
    if (bare) out.push({ icon: 'shelf', text: `<b>${bare}</b> ${bare > 1 ? 'shelves' : 'shelf'} empty` });

    const floor = (state.deliveries ?? []).length;
    if (floor) out.push({ icon: 'crate', text: `<b>${floor}</b> to put away` });

    // Turned soil with nothing in it is the farm equivalent of an empty shelf.
    const unsown = plots.filter((p) => p.soil === 'tilled' && !p.crop_id).length;
    if (unsown) out.push({ icon: 'seeds', text: `<b>${unsown}</b> plot${unsown > 1 ? 's' : ''} to sow` });

    return out.slice(0, 3);
  }

  selectCrop(id) {
    this.selectedCrop = id;
    // The server plants from its own copy — this only chooses.
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
      this.buildRot = this.holding?.rot ?? this.buildRot;
      this.renderHotbar();
      // Hands full is the lift landing. Hands empty again is the errand over,
      // however it ended — set down, put back, or the mode dropped underneath.
      if (heldId) this._lifting = false;
      else this.endMove();
    }
    this.syncBuildTool(me?.build);

    this.el.mods.innerHTML = state.modifiers
      .map((m) => {
        const up = m.demand_mult >= 1;
        return `<span class="mod ${up ? 'up' : 'down'}" title="${esc(m.label ?? m.tag)}">`
          + `<span class="arrow">${up ? '▲' : '▼'}</span>${esc(m.tag)} ×${m.demand_mult}</span>`;
      })
      .join('');

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
    if (this.openPanel && this.query) { this.clearFilter(); this.paintSection(); return; }
    if (this.openPanel) { this.closePanel(); return; }
    if (!this.buildOn) return;
    if (this.holding) { this.net.send('build-cancel', {}); return; }
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

  showPanel(title, html) {
    // innerHTML because a fixture menu's title leads with its icon, and an
    // icon is now an inline SVG rather than a character.
    this.el.panelTitle.innerHTML = title;
    this.el.panelBody.innerHTML = html;
    this.el.panel.classList.add('show');
    // Only a section has anything to filter. `paintSection` turns it back on
    // straight after; a fixture menu never does, so it can't inherit the
    // supplier's search box.
    this.el.filter.hidden = true;
  }
}
