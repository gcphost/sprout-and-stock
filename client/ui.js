/**
 * HUD and menus.
 *
 * Plain DOM over the canvas — no framework. Everything is driven from the
 * server snapshot, so the UI automatically shows content that was added live
 * without a page reload.
 */

import { FIXTURES, FIXTURE_REFUND } from '../shared/build.js';

/**
 * The build palette: only things you can put down.
 *
 * Move and Clear used to sit in this list, which made them tools that acted on
 * "whatever you are stood by" — and in an aisle of shelves that is not a choice
 * anyone can make. Everything you can do *to* a fixture now lives in that
 * fixture's own menu, so picking a tool is only ever picking what to buy.
 */
const BUILD_TOOLS = [
  {
    id: 'shelf',
    icon: '🗄',
    name: 'Shelf',
    blurb: 'Ordinary shelving. Holds anything that does not need freezing. Shoppers browse from the side it faces, so watch the ring when you rotate it.',
  },
  {
    id: 'freezer',
    icon: '🧊',
    name: 'Freezer',
    blurb: 'The only thing that will hold frozen goods, and it slows everything else down to a crawl too — four times the shelf life.',
  },
  {
    id: 'checkout',
    icon: '💳',
    name: 'Till',
    blurb: 'Somewhere to take money. The queue forms alongside, so a till needs a clear run beside it — the ghost goes red if there is nowhere to stand.',
  },
  {
    id: 'plot',
    icon: '🌱',
    name: 'Plot',
    blurb: 'A bed of earth, outside on the grass. Arrives rough — it needs turning over before it will take a seed.',
  },
];

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
    };
    // Touch devices don't have a mouse button to name, and "click" is wrong on
    // a phone. Decided once at boot rather than per frame.
    this.holdWord = matchMedia('(hover: none)').matches ? 'Hold' : 'Click &amp; hold';

    document.getElementById('panel-close').onclick = () => this.closePanel();
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.escape();
    });
    this.renderBuildBar();
  }

  setCatalog(catalog) {
    this.catalog = catalog;
    this.buildCosts = catalog.buildCosts ?? this.buildCosts;
    if (!this.selectedCrop && catalog.crops[0]) this.selectCrop(catalog.crops[0].id);
    if (this.wheelOpen) this.renderWheel();
    this.renderBuildBar();
    // If a panel is open, refresh it so newly-added content appears instantly.
    if (this.openPanel === 'stock') this.showStock();
    if (this.openPanel === 'upgrades') this.showUpgrades(this.ownedUpgrades);
  }

  // ---- build mode ----------------------------------------------------------

  toggleBuild(on = !this.buildOn) {
    this.buildOn = on;
    this.buildRot = 0;
    this.el.build.classList.toggle('on', on);
    document.body.classList.toggle('building', on);
    if (!on && this.openPanel === 'fixture') this.closePanel();
    this.net.send('build-mode', { on, tool: this.buildTool });
    this.renderBuildBar();
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
    this.renderBuildBar();
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
    this.renderBuildBar();
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

  renderBuildBar() {
    if (!this.el.buildTools) return;
    this.el.buildTools.innerHTML = BUILD_TOOLS.map((t, i) => {
      const cost = this.buildCosts[t.id];
      const price = cost == null ? '' : `<span class="cost">$${cost.toFixed(0)}</span>`;
      return `<button class="tool ${t.id === this.buildTool ? 'on' : ''}" data-tool="${t.id}">
          <span class="key">${i + 1}</span>
          <span class="ico">${t.icon}</span>
          <span class="nm">${t.name}</span>${price}
        </button>`;
    }).join('')
      + `<button class="tool more" data-build-menu="1">
          <span class="key">M</span><span class="ico">☰</span><span class="nm">Menu</span>
        </button>`;

    this.el.buildTools.querySelectorAll('[data-tool]').forEach((b) => {
      b.onclick = () => this.selectBuildTool(b.dataset.tool);
    });
    this.el.buildTools.querySelector('[data-build-menu]').onclick = () => this.showBuild();
    this.renderBuildHint();
  }

  /**
   * The line under the build bar. It has three things to say and says exactly
   * one of them: what you're carrying, what you're pointing at, or what tapping
   * bare ground would build.
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
    this.renderBuildHint();
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

  /**
   * The full build menu.
   *
   * The bar along the bottom is for picking something you already know you
   * want; this is for working out what you want. It says what each thing is
   * for, what it costs, and how many you already have — none of which fits on
   * a 62px button.
   */
  showBuild() {
    this.openPanel = 'build';
    if (!this.buildOn) this.toggleBuild(true);
    const owned = this.fixtureCounts ?? {};

    const row = (t) => {
      const cost = this.buildCosts[t.id];
      const have = owned[t.id];
      return `
        <div class="row build-row ${t.id === this.buildTool ? 'picked' : ''}" data-pick="${t.id}">
          <span class="bico">${t.icon}</span>
          <div class="name">${t.name}${have != null ? ` <span class="own">you have ${have}</span>` : ''}
            <span class="tags">${t.blurb}</span>
          </div>
          <div class="price">${cost == null ? '' : `$${cost.toFixed(0)}`}</div>
        </div>`;
    };

    this.showPanel('Build', `
      ${BUILD_TOOLS.map(row).join('')}
      <div class="foot">Tap bare ground to place · <b>R</b> rotates · drag still walks you around.
      To move, turn, empty or sell something you already own, tap the thing itself —
      everything in the shop has its own menu. Appliances come from the Upgrades menu.</div>
    `);

    this.el.panelBody.querySelectorAll('[data-pick]').forEach((el) => {
      el.onclick = () => {
        this.selectBuildTool(el.dataset.pick);
        this.closePanel();
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
    // The build menu shows how many of each you own, so keep it live — and
    // refresh the panel if it's open when the count changes under it.
    const counts = state.fixtures ?? null;
    if (counts && JSON.stringify(counts) !== this._countsKey) {
      this._countsKey = JSON.stringify(counts);
      this.fixtureCounts = counts;
      if (this.openPanel === 'build') this.showBuild();
    }

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
      this.renderBuildBar();
    }
    this.syncBuildTool(me?.build);

    this.el.mods.innerHTML = state.modifiers
      .map((m) => `<span class="mod ${m.demand_mult >= 1 ? 'up' : 'down'}">${m.tag} ×${m.demand_mult}</span>`)
      .join('');

    // The wheel reads these when it paints, so keep them fresh.
    this._season = state.season;
    this._cash = state.cash;
    if (this.wheelOpen) this.paintWheel();

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
  }

  /**
   * One press, one layer. An open menu first, then the fixture in your hands,
   * then build mode itself — so Escape never quits building when all you wanted
   * was to shut a panel.
   */
  escape() {
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

  /** Buy wholesale stock — the only way to get items you can't grow. */
  showStock() {
    this.openPanel = 'stock';
    const rows = this.catalog.items.map((it) => `
      <div class="row">
        <div class="name">${it.name}<span class="tags">${it.tags.slice(0, 3).join(' · ')}</span></div>
        <div class="price">$${it.base_cost.toFixed(2)}</div>
        <button data-buy="${it.id}" data-qty="6">×6</button>
      </div>`).join('');
    this.showPanel('Supplier', rows || '<p>No items exist yet.</p>');

    this.el.panelBody.querySelectorAll('[data-buy]').forEach((b) => {
      b.onclick = () => this.net.send('buy-stock', { itemId: b.dataset.buy, qty: Number(b.dataset.qty) });
    });
  }

  showUpgrades(owned = this.ownedUpgrades ?? []) {
    this.openPanel = 'upgrades';
    const rows = this.catalog.upgrades.map((u) => {
      const have = owned.includes(u.id);
      return `
      <div class="row ${have ? 'owned' : ''}">
        <div class="name">${u.name}<span class="tags">${u.description}</span></div>
        <div class="price">$${u.cost.toFixed(0)}</div>
        ${have ? '<span class="have">owned</span>' : `<button data-up="${u.id}">buy</button>`}
      </div>`;
    }).join('');
    this.showPanel('Upgrades', rows || '<p>No upgrades defined.</p>');

    this.el.panelBody.querySelectorAll('[data-up]').forEach((b) => {
      b.onclick = () => this.net.send('buy-upgrade', { upgradeId: b.dataset.up });
    });
  }
}
