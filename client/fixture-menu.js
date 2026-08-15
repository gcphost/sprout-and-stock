/**
 * One menu per fixture.
 *
 * Tapping a shelf opens that shelf. Not "the nearest shelf", not "a shelf" —
 * the one you tapped, named by id, which is the whole reason moving things used
 * to grab the wrong one. Everything a fixture can do lives here, so the list is
 * allowed to be different for a freezer than for a plot.
 *
 * Functions take `ui` first rather than living on it: this is a menu that reads
 * the snapshot and sends messages, not part of the HUD's own state.
 */

import { FIXTURES, FIXTURE_REFUND } from '../shared/build.js';
import { pieceFor } from '../shared/pieces.js';
import { tierProgress, variantsOf } from '../shared/model.js';
import { ICONS } from './icons.js';

/** How each kind of fixture shows up in its own menu. */
const FIXTURE_ICON = {
  shelf: ICONS.shelf, freezer: ICONS.freezer, checkout: ICONS.checkout,
  plot: ICONS.plot, station: ICONS.station,
};

/**
 * A row that is a verb: an icon, what it does, why you would, and what it
 * costs or pays. Exported because a hire's menu offers verbs too, and two
 * copies of this template would drift the first time one of them was styled.
 */
export const act = (id, icon, name, sub, { danger = false, off = false, right = '' } = {}) => `
  <div class="row fx-act ${off ? 'off' : ''} ${danger ? 'danger' : ''}" ${off ? '' : `data-act="${id}"`}>
    <span class="bico">${icon}</span>
    <div class="name">${name}<span class="tags">${sub}</span></div>
    <div class="price">${right}</div>
  </div>`;

/**
 * Open the menu for one fixture.
 *
 * @param {object} ui the HUD
 * @param {object} f a layout record: { id, kind, x, z, rot, station }
 */
export function showFixture(ui, f) {
  if (!f) return;
  ui.openPanel = 'fixture';
  // A fixture menu is not a section, so nothing on the rail is open.
  ui.rail.setOpen(null);
  // The whole layout record is kept, not just its id: turning something
  // re-mints its id (it becomes a fresh placement), and the menu should stay
  // open on the thing that is still sitting right there on that tile.
  ui.fixtureRef = f;
  // One callback, called every snapshot, that redraws this only when what it
  // shows has actually moved — stock going down, a crop ripening, a queue
  // forming. The HUD holds one of these rather than a branch per kind of menu.
  ui.panelTick = tickFixture;

  const live = liveFixture(ui, f);
  ui._fxMenuKey = fixtureSignature(ui, f, live);
  const kind = f.kind;
  const refund = refundFor(ui, f);
  const blocked = removeBlockedReason(ui, f, live);

  const parts = [fixtureDetail(ui, f, live)];

  // Everything on this menu that renders as a *row* shares one list, because
  // `wireRows` binds by index: two lists each numbered from zero would hand the
  // seed picker's clicks to the shape picker.
  const rows = [];
  const asRows = (list) => {
    const html = list.map((r, i) => ui.rowHtml(r, rows.length + i)).join('');
    rows.push(...list);
    return html;
  };

  // What to plant belongs to the plot you're stood at, not to a menu of its own
  // three icons away. It sets the same one seed the wheel does — the choice is
  // the player's, not the plot's — but this is where you are when you want it,
  // and at an empty bed it outranks moving or selling the thing.
  // A ripe bed offers no seeds: picking one there would throw the harvest away.
  const seeds = f.kind === 'plot' && !live?.ready ? seedRows(ui, f, live) : [];
  if (seeds.length) {
    parts.push(`<div class="sep">${live?.crop_id ? 'Sow it with something else' : 'Sow it with'}</div>`);
    parts.push(asRows(seeds));
  }

  parts.push('<div class="sep">Do something with it</div>');
  parts.push(act('move', ICONS.move, 'Move it',
    'Picks it up with everything on it. Nothing shifts until you set it down.'));

  if (FIXTURES[kind]?.rotates) {
    // Which side a thing faces means something different for each of them,
    // and it's the reason to turn it at all — so say the actual reason.
    const why = {
      checkout: 'Quarter turn. Sets where you serve and which way the queue runs.',
      station: 'Quarter turn. Sets which side you load it from.',
    }[kind] ?? 'Quarter turn. Sets which aisle shoppers browse it from.';
    parts.push(act('rotate', ICONS.rotate, 'Turn it round', why));
  }

  // Upgrading sits above the destructive half of the list: it is the thing you
  // are most likely to have opened a shelf you already like in order to do.
  const next = nextTier(ui, f);
  if (next) {
    const afford = (ui.state?.cash ?? 0) >= next.cost;
    // The tier name is authored content and can be any length, so it goes in the
    // wrapping description rather than the one-line title — `Upgrade to With a
    // register` was both clipped and barely a sentence. The title is the verb,
    // which is fixed and short; the row below it says what you actually get.
    const blurb = `${next.name} — ${tierBlurb(next)}`;
    parts.push(act('upgrade', ICONS.tierup, 'Upgrade',
      afford ? blurb : `${blurb} You cannot afford it yet.`,
      // A tier that is purely cosmetic still costs nothing, and `$0` in the
      // price column reads as a broken number rather than as good news.
      { off: !afford, right: next.cost > 0 ? `$${next.cost.toFixed(0)}` : 'free' }));
  }

  // Every shape this kind comes in. It sits under Upgrade because the two read
  // as a pair and are deliberately opposites: a tier costs money and changes
  // what the thing does, a style is free and changes only how it looks.
  const styles = styleRows(ui, f);
  if (styles.length > 1) {
    parts.push('<div class="sep">Shape</div>');
    parts.push(asRows(styles));
  }

  const holds = contentsOf(ui, f, live);
  if (holds.n > 0) {
    parts.push(act('empty', ICONS.empty, 'Empty it', holds.blurb, { right: `${holds.n}` }));
  } else if ((kind === 'shelf' || kind === 'freezer') && live?.item_id) {
    parts.push(act('empty', ICONS.label, 'Take the label off',
      `Still reserved for ${ui.itemName(live.item_id)}. Clear it and anything can go on.`));
  }

  parts.push(act('remove', ICONS.remove, kind === 'station' ? 'Sell it back' : 'Remove it',
    blocked ?? 'Half of what it cost back.',
    { danger: true, off: !!blocked, right: blocked ? '' : `+$${refund.toFixed(2)}` }));

  parts.push(fixtureUpgrades(ui, f));

  ui.showPanel(`${FIXTURE_ICON[kind] ?? ICONS.crate} ${ui.fixtureName(f)}`, parts.join(''));
  wireFixtureMenu(ui, f, live);
  if (rows.length) ui.wireRows(rows);
}

/**
 * The shapes this kind comes in, as pickable rows.
 *
 * Free, and it keeps the stock — restyling goes through the same reposition
 * path moving and turning do. So this is a decision you can take back, which is
 * the whole reason it can sit in the menu next to Remove without a warning.
 */
function styleRows(ui, f) {
  const here = f.variant ?? '';
  return variantsOf(pieceFor(ui.catalog.fixtures ?? [], f)).map((v) => ({
    icon: ICONS.fixtures,
    name: v.name,
    sub: v.id === here ? 'what this one is' : 'free — it keeps whatever is on it',
    picked: v.id === here,
    run: v.id === here ? null : () => ui.withBuildMode(() => {
      ui.net.send('build-style', { id: f.id, variant: v.id });
    }),
  }));
}

/**
 * Keep the open fixture menu honest against the snapshot.
 *
 * The tile is re-read rather than the record trusted, for the same reason
 * `refreshFixture` does it — see the note there.
 */
function tickFixture(ui) {
  if (ui.openPanel !== 'fixture' || !ui.fixtureRef) return;
  const f = ui.scene?.fixtureAt(ui.fixtureRef.x, ui.fixtureRef.z) ?? null;
  if (!f) { ui.closePanel(); return; }
  if (fixtureSignature(ui, f, liveFixture(ui, f)) !== ui._fxMenuKey) showFixture(ui, f);
}

/**
 * Every crop, as pickable rows — the same shape a section's rows take.
 *
 * Clicking one *sows this bed*, rather than setting a preference you then have
 * to go and act on. The server does the tilling and charges for the seed.
 */
function seedRows(ui, f, live) {
  return ui.catalog.crops.map((c) => {
    const inSeason = !c.seasons?.length || c.seasons.includes(ui._season);
    const affordable = (ui._cash ?? 0) >= c.seed_cost;
    const growing = live?.crop_id === c.id;
    return {
      icon: ICONS.seeds,
      name: c.name,
      sub: growing
        ? `growing here · ${Math.round((live.growth ?? 0) * 100)}% up`
        : (inSeason
          ? `${Math.round(c.grow_minutes)} min · ${c.seasons?.length ? c.seasons.join(', ') : 'any season'}`
          : `out of season · ${c.seasons.join(', ')}`),
      right: growing ? '' : `$${c.seed_cost.toFixed(2)}`,
      picked: growing,
      dim: !growing && (!inSeason || !affordable),
      run: growing ? null : () => ui.net.send('sow', { plotId: f.id, cropId: c.id }),
    };
  });
}

/**
 * Keep the open fixture menu honest.
 *
 * Called with the fresh layout after any re-flow. A fixture that was turned has
 * a new id on the same tile, so follow it there; one that was removed is gone
 * and the menu goes with it.
 */
export function refreshFixture(ui, fixtures) {
  if (ui.openPanel !== 'fixture' || !ui.fixtureRef) return;
  const at = ui.fixtureRef;
  // Tile first, id second — and that order is load-bearing. The generator mints
  // `shelf-p0`, `shelf-p1`… positionally and re-mints them on every re-flow, so
  // turning a procedural shelf both gives it a new `fx-N` id and frees its old
  // name for a completely different shelf. Looking up by id would quietly
  // re-point this menu at that other shelf, which is the exact bug this whole
  // screen exists to kill.
  const found = fixtures.find((f) => f.x === at.x && f.z === at.z && f.kind === at.kind)
    ?? fixtures.find((f) => f.id === at.id);
  if (!found) { ui.closePanel(); return; }
  showFixture(ui, found);
}

/** The live snapshot row for a fixture — its stock, crop or hopper. */
export function liveFixture(ui, f) {
  const s = ui.state;
  if (!s) return null;
  if (f.kind === 'shelf' || f.kind === 'freezer') return s.shelves?.find((x) => x.id === f.id) ?? null;
  if (f.kind === 'plot') return s.plots?.find((x) => x.id === f.id) ?? null;
  if (f.kind === 'station') return s.stations?.find((x) => x.id === f.id) ?? null;
  if (f.kind === 'checkout') return s.queues?.find((x) => x.id === f.id) ?? null;
  return null;
}

/** Everything the open menu draws from, so it can redraw when any of it moves. */
export function fixtureSignature(ui, f, live) {
  return JSON.stringify([f.id, f.rot, f.tier, live, ui.state?.cash?.toFixed(0),
    ui.ownedUpgrades?.length, ui.selectedCrop, ui._season]);
}

/** The read-out at the top: what this particular thing is doing right now. */
function fixtureDetail(ui, f, live) {
  const line = (label, value) => `<div class="fx-line"><span>${label}</span><b>${value}</b></div>`;

  if (f.kind === 'shelf' || f.kind === 'freezer') {
    const item = live?.item_id ? ui.itemById(live.item_id) : null;
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
    const crop = live?.crop_id ? ui.catalog.crops.find((c) => c.id === live.crop_id) : null;
    return `<div class="fx-detail">
      ${line('Soil', live?.soil === 'tilled' ? 'turned over, ready' : 'rough — needs tilling')}
      ${line('Growing', crop ? crop.name : '<i>nothing</i>')}
      ${crop ? line('Ready', live.ready ? 'yes — go and pick it' : `${Math.round((live.growth ?? 0) * 100)}%`) : ''}
    </div>`;
  }

  if (f.kind === 'checkout') {
    const q = ui.state?.queues?.find((c) => c.id === f.id);
    // How long a line it can take is the thing worth knowing before you turn
    // it: past that, shoppers pile up on the last slot instead of queueing.
    return `<div class="fx-detail">
      ${line('Queue', `${q?.queue ?? 0} waiting`)}
      ${line('Room for', `${f.queueMax ?? 0} in the line`)}
    </div>`;
  }

  if (f.kind === 'station') {
    const inside = Object.entries(live?.contents ?? {})
      .map(([id, n]) => `${n}× ${ui.itemName(id)}`).join(', ');

    // Every recipe, with each ingredient counted against what's actually in the
    // hopper. Listing recipe *names* was the whole problem: "Can make: Flat
    // White" tells you nothing about why it isn't, and the ingredients were
    // written down nowhere in the game at all.
    const recipes = (ui.catalog.recipes ?? []).filter((r) => r.station === f.station);
    const held = (id) => live?.contents?.[id] ?? 0;
    const body = recipes.map((r) => `
      <div class="fx-recipe">
        <div class="fx-recipe-h">
          <span>${r.name}</span>
          <b>makes ${r.output_qty ?? 1}×</b>
        </div>
        ${r.inputs.map((i) => `
          <div class="fx-ing${held(i.item_id) >= i.qty ? ' ok' : ''}">
            <span>${ui.itemName(i.item_id)}</span>
            <b>${held(i.item_id)} / ${i.qty}</b>
          </div>`).join('')}
      </div>`).join('');

    return `<div class="fx-detail">
      ${line('In the hopper', inside || '<i>empty</i>')}
      ${line('Making', live?.making ? ui.itemName(live.output?.item_id ?? live.making) : '<i>idle</i>')}
      ${body || line('Can make', '<i>no recipes yet</i>')}
    </div>`;
  }
  return '';
}

/** Upgrades that add more of this kind of thing — bought right from here. */
function fixtureUpgrades(ui, f) {
  const owned = ui.ownedUpgrades ?? [];
  const relevant = (ui.catalog.upgrades ?? [])
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

function wireFixtureMenu(ui, f, live) {
  const send = (type, payload) => ui.net.send(type, payload);

  ui.el.panelBody.querySelectorAll('[data-act]').forEach((el) => {
    // Every one of these is a verb the server gates on build mode, and this menu
    // opens with or without it — so the press carries the mode in rather than
    // bouncing off it. Sowing a seed above is the odd one out and needs nothing.
    el.onclick = () => ui.withBuildMode(() => {
      const what = el.dataset.act;
      if (what === 'move') {
        // One errand, start to finish: `startMove` holds the mode open across
        // the carry and `endMove` reopens this menu on it wherever it lands.
        ui.startMove(f);
        send('build-lift', { id: f.id });
        ui.closePanel();
        ui.toast(`Carrying the ${ui.fixtureName(f).toLowerCase()} — tap where it should go`);
      } else if (what === 'rotate') {
        send('build-rotate', { id: f.id, dir: 1 });
      } else if (what === 'empty') {
        send('build-empty', { id: f.id });
      } else if (what === 'upgrade') {
        send('build-upgrade', { id: f.id });
      } else if (what === 'remove') {
        send('build-remove', { id: f.id });
        ui.closePanel();
      }
    });
  });

  ui.el.panelBody.querySelectorAll('[data-price]').forEach((el) => {
    el.onclick = () => {
      const step = Number(el.dataset.price) * 0.25;
      const next = Math.max(0, Math.round(((live?.price ?? 0) + step) * 100) / 100);
      send('set-price', { shelfId: f.id, price: next });
    };
  });

  ui.el.panelBody.querySelectorAll('[data-up]').forEach((el) => {
    el.onclick = () => send('buy-upgrade', { upgradeId: el.dataset.up });
  });
}

/**
 * The tier ladder for this kind of fixture, from content. A kind nobody has
 * authored tiers for simply has one rung, and no upgrade row appears.
 */
function tiersOf(ui, f) {
  // The piece this fixture is, not its kind: two shelf designs may climb
  // different ladders, and reading the wrong one prices the wrong upgrade.
  const tiers = pieceFor(ui.catalog.fixtures ?? [], f)?.tiers;
  return tiers?.length ? tiers : [{ name: 'Standard', cost: 0 }];
}

/** Which rung this particular fixture is on. */
export function tierOf(ui, f) {
  return Math.min(Math.max(1, Math.trunc(f.tier ?? 1)), tiersOf(ui, f).length);
}

/** The next rung up, or null when it is already the best there is. */
function nextTier(ui, f) {
  const tiers = tiersOf(ui, f);
  const next = tiers[tierOf(ui, f)];
  return next ? { ...next, tier: tierOf(ui, f) + 1 } : null;
}

/** Say what a tier actually buys you, from its own numbers. */
function tierBlurb(tier) {
  const gains = [];
  if ((tier.capacity_mult ?? 1) !== 1) gains.push(`holds ${mult(tier.capacity_mult)} as much`);
  if ((tier.keeps_mult ?? 1) !== 1) gains.push(`keeps things ${mult(tier.keeps_mult)} as long`);
  if ((tier.speed_mult ?? 1) !== 1) gains.push(`works ${mult(tier.speed_mult)} as fast`);
  return gains.length ? `${gains.join(', ')}.` : 'Same job, better looking.';
}

const mult = (n) => `${Number(n) % 1 === 0 ? n : Number(n).toFixed(1)}×`;

/** What "empty it" would tip out, and how to describe it. */
function contentsOf(ui, f, live) {
  if (f.kind === 'shelf' || f.kind === 'freezer') {
    const n = live?.qty ?? 0;
    return { n, blurb: n ? `${n}× ${ui.itemName(live.item_id)} into a crate beside it.` : '' };
  }
  if (f.kind === 'station') {
    const n = Object.values(live?.contents ?? {}).reduce((a, b) => a + b, 0) + (live?.output?.qty ?? 0);
    return { n, blurb: 'Tips the hopper into crates. A batch going is left to finish.' };
  }
  if (f.kind === 'plot') {
    const n = live?.crop_id ? 1 : 0;
    return { n, blurb: 'Pulls the crop and leaves the bed rough. A half-grown crop is lost.' };
  }
  return { n: 0, blurb: '' };
}

/** Why Remove is greyed out, or null if it isn't. */
function removeBlockedReason(ui, f, live) {
  if (contentsOf(ui, f, live).n > 0) return 'Empty it first.';
  if (f.kind === 'checkout' && (ui.state?.queues?.length ?? 0) <= 1) {
    return 'Your only till.';
  }
  return null;
}

/**
 * What tearing this out pays. The same fraction the server uses, imported from
 * `shared/build.js` — a button that promises a different number to the one you
 * get is worse than no number at all.
 */
function refundFor(ui, f) {
  if (f.kind === 'station') {
    const up = (ui.catalog.upgrades ?? []).find((u) => u.kind === 'station'
      && u.payload?.station === f.station && (ui.ownedUpgrades ?? []).includes(u.id));
    return (up?.cost ?? 0) * FIXTURE_REFUND;
  }
  return (ui.buildCosts[f.kind] ?? 0) * FIXTURE_REFUND;
}
