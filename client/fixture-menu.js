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
import { requiredFixture } from '../shared/tags.js';
import { tierProgress, variantsOf } from '../shared/model.js';
import { ICONS } from './icons.js';

/**
 * Group labels are ours, not the database's — but they are about to be printed
 * into a `title` attribute, and one of them is built from an authored crop name
 * away. Escaping here costs nothing and does not have to be re-argued later.
 */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

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
    <div class="name">${name}${sub ? `<span class="tags">${sub}</span>` : ''}</div>
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
  // Which tab is showing belongs to the thing you are looking at, not to the
  // menu — so opening a different fixture starts at the front again. By TILE
  // rather than by id, the same call `refreshFixture` makes and for the same
  // reason: turning something re-mints its id, and a tab that reset itself
  // every time you pressed Rotate would be its own small bug.
  const on = `${f.kind}@${f.x},${f.z}`;
  if (ui._fxTabOn !== on) { ui._fxTabOn = on; ui._fxTab = 0; }

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

  // Three regions, the same shape a hire's menu settled on and for the same
  // reason. What this thing IS stays pinned at the top; what you can DO about
  // it stays pinned at the bottom; and the middle — the only part with no
  // ceiling on its length — is what scrolls.
  //
  // A shelf is the worst case and the reason this changed. Its middle is every
  // item in the catalog, which is content and grows, so Move, Rotate, Upgrade
  // and Remove sat below a list that got longer every time anybody authored a
  // tomato. The verbs are the fixed part of this menu — the same five in the
  // same order on every fixture in the game — and they were the part you had to
  // go looking for.
  const groups = [];
  const group = (label, icon, rows) => {
    if (rows?.length) groups.push({ label, icon, rows });
  };

  // What to plant belongs to the plot you're stood at, not to a menu of its own
  // three icons away. It sets the same one seed the wheel does — the choice is
  // the player's, not the plot's — but this is where you are when you want it,
  // and at an empty bed it outranks moving or selling the thing.
  // A ripe bed offers no seeds: picking one there would throw the harvest away.
  if (f.kind === 'plot' && !live?.ready) {
    group(live?.crop_id ? 'Sow something else' : 'Sow it with', ICONS.seeds,
      seedRows(ui, f, live));
  }

  // Anything that holds stock gets the same treatment a bed gets: what goes in
  // it is decided at the thing itself. A shelf's answer is a standing one
  // rather than a single sowing, so it also gets to say how eagerly the shop
  // keeps that promise — which is the difference between "we sell milk here"
  // and "we are never out of milk".
  if (kind === 'shelf' || kind === 'freezer') {
    group(live?.assigned ? 'Kept for' : 'Keep it for', ICONS.crate, stockRows(ui, f, live));
    group('When it gets refilled', ICONS.supplier, priorityRows(ui, f, live));
  }

  // A shape is free and keeps whatever is on it, so it is a browse rather than a
  // decision — which is exactly what belongs in the scrolling half. One shape is
  // not a choice, so a kind nobody has drawn a second design for gets no tab.
  const styles = styleRows(ui, f);
  if (styles.length > 1) group('Shape', ICONS.fixtures, styles);

  group('More of these', ICONS.build, moreOfTheseRows(ui, f));

  // ---- the head: what it is ------------------------------------------------
  const parts = [`<div class="pnl-head">${fixtureDetail(ui, f, live)}</div>`];

  // ---- the middle: the long half, tabbed once there is more than one --------
  //
  // Tabs by the same rule sections use (`tabGroups` in ui.js): two or more
  // groups earns them, one does not. Forcing tabs on a till — which has only
  // ever had shapes to show — would hide three rows behind a click each.
  const rows = [];
  const at = Math.min(ui._fxTab ?? 0, Math.max(0, groups.length - 1));
  if (groups.length > 1) {
    parts.push(`<div class="tabs">${groups.map((g, n) => `
      <button class="tab${n === at ? ' on' : ''}" data-fxtab="${n}" title="${esc(g.label)}"
        aria-label="${esc(g.label)}">${g.icon}</button>`).join('')}</div>`);
  }
  if (groups.length) {
    const open = groups[at];
    // Named above its rows even with the tabs up, because an icon row is a
    // shape you learn and a heading is a thing you read — and on first open
    // nobody knows which pictogram is the seed one.
    parts.push(`<div class="sep">${esc(open.label)}</div>`);
    // One list, numbered once: `wireRows` binds by index, so two lists each
    // starting at zero would hand the seed picker's clicks to the shape picker.
    parts.push(open.rows.map((r, i) => ui.rowHtml(r, i)).join(''));
    rows.push(...open.rows);
  }

  // ---- the foot: what you can do about it ----------------------------------
  //
  // One line each, and that is the price of being pinned. Five verbs explaining
  // themselves in two lines apiece is half a panel of standing prose that never
  // changes and is read exactly once — and it was squeezing the half of the
  // menu that actually has something to say down to a single visible row.
  //
  // So a sub-line has to earn its place by carrying something you cannot get
  // from the row itself: what a tier gives you, or why Remove is refusing. Move
  // it, Rotate and Empty it are two-word verbs for exactly what they say, and
  // their counts and prices are already in the right-hand column.
  const foot = [];

  foot.push(act('move', ICONS.move, 'Move it', ''));
  if (FIXTURES[kind]?.rotates) foot.push(act('rotate', ICONS.rotate, 'Rotate', ''));

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
    foot.push(act('upgrade', ICONS.tierup, 'Upgrade',
      afford ? blurb : `${blurb} You cannot afford it yet.`,
      // A tier that is purely cosmetic still costs nothing, and `$0` in the
      // price column reads as a broken number rather than as good news.
      { off: !afford, right: next.cost > 0 ? `$${next.cost.toFixed(0)}` : 'free' }));
  }

  const holds = contentsOf(ui, f, live);
  if (holds.n > 0) {
    foot.push(act('empty', ICONS.empty, 'Empty it', '', { right: `${holds.n}` }));
  } else if ((kind === 'shelf' || kind === 'freezer') && live?.item_id) {
    // A label is what was last on it; what it is *kept* for is a tab above and
    // survives this. This one keeps its sub-line, because "take the label off"
    // does not say WHICH label — and on a shelf that is also kept for something
    // else, not saying so is the menu looking like it will undo both.
    foot.push(act('empty', ICONS.label, 'Take the label off',
      live.assigned
        ? `${ui.itemName(live.item_id)} — stays kept for ${ui.itemName(live.assigned)}`
        : `${ui.itemName(live.item_id)} — then anything can go on`));
  }

  // The refund is in the right-hand column, so the sub-line is free to be the
  // one thing it cannot say: why the row is greyed out.
  foot.push(act('remove', ICONS.remove, kind === 'station' ? 'Sell it back' : 'Remove it',
    blocked ?? '',
    { danger: true, off: !!blocked, right: blocked ? '' : `+$${refund.toFixed(2)}` }));

  parts.push(`<div class="pnl-foot">${foot.join('')}</div>`);

  ui.showPanel(`${FIXTURE_ICON[kind] ?? ICONS.crate} ${ui.fixtureName(f)}`, parts.join(''));
  wireFixtureMenu(ui, f, live);
  if (rows.length) ui.wireRows(rows);
  ui.el.panelBody.querySelectorAll('[data-fxtab]').forEach((el) => {
    // Redrawn rather than shown/hidden, because the rows are live: a tab built
    // once would still be offering to sow a bed that has since been harvested.
    el.onclick = () => { ui._fxTab = Number(el.dataset.fxtab); showFixture(ui, f); };
  });
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
 * Every item this fixture could be kept for, as pickable rows.
 *
 * The list is what a *freezer* is for or what a *shelf* is for, never both, and
 * that is the rule `assignShelf` enforces rather than the looser one your own
 * hands get. You may stand a loaf in a freezer by hand; reserving one for bread
 * is an instruction no stocker will ever carry out, and a row that can only
 * ever error is worse than a row that isn't there.
 */
function stockRows(ui, f, live) {
  const freezer = f.kind === 'freezer';
  const kept = live?.assigned ?? null;
  // Where else this is already spoken for — so nobody reserves the same thing
  // on three shelves and wonders why two of them stay empty.
  const elsewhere = new Set((ui.state?.shelves ?? [])
    .filter((s) => s.id !== f.id && s.assigned)
    .map((s) => s.assigned));
  // What this particular unit would hold of it, tier included: "12x" on a shelf
  // you have upgraded twice is the number that shelf actually takes.
  const capMult = tiersOf(ui, f)[tierOf(ui, f) - 1]?.capacity_mult ?? 1;

  const rows = (ui.catalog.items ?? [])
    .filter((it) => (requiredFixture(it) === 'freezer') === freezer)
    .map((it) => ({
      icon: ICONS.crate,
      name: it.name,
      sub: kept === it.id
        ? 'kept for this — staff refill it with nothing else'
        : (elsewhere.has(it.id)
          ? 'another shelf is already kept for this'
          : (it.tags ?? []).join(', ')),
      right: `${Math.max(1, Math.floor((it.stack ?? 1) * capMult))}×`,
      picked: kept === it.id,
      dim: kept !== it.id && elsewhere.has(it.id),
      run: kept === it.id ? null
        : () => ui.net.send('assign', { shelfId: f.id, itemId: it.id }),
    }));

  // Handing it back, at the top — and only once there is something to hand
  // back, because "anything at all" is what a shelf already is by default.
  if (kept) {
    rows.unshift({
      icon: ICONS.label,
      name: 'Anything at all',
      sub: 'Stop keeping it for one thing. Staff fill it with whatever sells.',
      run: () => ui.net.send('assign', { shelfId: f.id, itemId: null }),
    });
  }
  return rows;
}

/**
 * Where this shelf sits in the queue when the van goes out.
 *
 * Three steps rather than a number, because the only thing anyone wants to say
 * is which end of the queue this goes on — a shop of eleven shelves each
 * holding its own integer is a spreadsheet, not a decision.
 */
const PRIORITIES = [
  { at: 1, name: 'Fill this one first', sub: 'Ahead of every other shelf that is running low.' },
  { at: 0, name: 'As it comes', sub: 'Emptiest shelf first, like everything else.' },
  { at: -1, name: 'Fill it last', sub: 'Only once nothing else needs filling.' },
];

function priorityRows(ui, f, live) {
  const at = live?.priority ?? 0;
  return PRIORITIES.map((p) => ({
    icon: ICONS.supplier,
    name: p.name,
    sub: p.sub,
    picked: p.at === at,
    run: p.at === at ? null
      : () => ui.net.send('restock-order', { shelfId: f.id, priority: p.at }),
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
    ui.ownedUpgrades?.length, ui.selectedCrop, ui._season,
    // Which tab is showing. In here because a snapshot redraw rebuilds the
    // whole panel from this function's verdict, and a signature blind to the
    // tab would let the next tick repaint the menu on the tab you had just
    // left — a press that visibly undoes itself a tenth of a second later.
    ui._fxTab ?? 0,
    // What every *other* shelf is kept for. This menu says which items are
    // already spoken for elsewhere, so it has to redraw when somebody else
    // spoke for one — `live` is only ever this shelf's own row.
    (ui.state?.shelves ?? []).map((s) => s.assigned ?? '').join(',')]);
}

/** The read-out at the top: what this particular thing is doing right now. */
function fixtureDetail(ui, f, live) {
  const line = (label, value) => `<div class="fx-line"><span>${label}</span><b>${value}</b></div>`;

  if (f.kind === 'shelf' || f.kind === 'freezer') {
    const item = live?.item_id ? ui.itemById(live.item_id) : null;
    // The stack times what this unit's tier multiplies it by, which is what the
    // server actually enforces. Reading `stack` alone said 12/12 on a shelf
    // that would happily take six more — so the capacity you had paid for read
    // as full, and the rows below would have disagreed with the line above.
    const capMult = tiersOf(ui, f)[tierOf(ui, f) - 1]?.capacity_mult ?? 1;
    const cap = item ? Math.max(1, Math.floor(item.stack * capMult)) : null;
    return `<div class="fx-detail">
      ${line('Holding', item ? item.name : '<i>nothing</i>')}
      ${line('Stock', cap ? `${live.qty} / ${cap}` : `${live?.qty ?? 0}`)}
      ${live?.assigned ? line('Kept for', ui.itemName(live.assigned)) : ''}
      ${live?.priority ? line('Refilled', live.priority > 0 ? 'first' : 'last') : ''}
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

/**
 * Deals on this kind of fixture — bought right from here.
 *
 * Ordinary rows now rather than its own hand-rolled table with a `buy` button
 * in it. That template was the one thing on this menu that drew itself, so it
 * was also the one thing that could not be a tab, could not be searched and did
 * not grey out when you couldn't afford it. A row already does all three.
 *
 * They are deals rather than deliveries — see `fixtureDiscount`. Saying so is
 * the whole reason the row needs a sub-line: "More of these" over a row that
 * hands you a *rate* is the section heading lying about its contents.
 */
function moreOfTheseRows(ui, f) {
  const owned = ui.ownedUpgrades ?? [];
  const cash = ui.state?.cash ?? 0;
  return (ui.catalog.upgrades ?? [])
    .filter((u) => u.kind === f.kind && !owned.includes(u.id))
    .map((u) => ({
      icon: ICONS.upgrades,
      name: u.name,
      sub: u.description || 'A better price on every one of these you build from now on.',
      right: `$${u.cost.toFixed(0)}`,
      dim: cash < u.cost,
      run: cash < u.cost ? null : () => ui.net.send('buy-upgrade', { upgradeId: u.id }),
    }));
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

  // `[data-up]` retired with the hand-rolled deals table: a deal is a row now,
  // and a row carries its own `run`.
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
  // Keyed the way the palette and the server both key a price: by piece, and by
  // machine for an appliance. Looking it up by KIND was right only while every
  // design of a kind cost the same — since step 9 a price is a property of the
  // row, so a shelf that cost $200 would have offered half of $45 back.
  const key = f.kind === 'station' ? `station:${f.station}` : (f.piece || f.kind);
  return (ui.buildCosts?.[key] ?? 0) * FIXTURE_REFUND;
}
