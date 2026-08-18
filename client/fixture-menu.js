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

import { FIXTURES, FIXTURE_REFUND, STOCK_KINDS, holdsGoods, shelfKind } from '../shared/build.js';
import { pieceFor } from '../shared/pieces.js';
import { homeKind } from '../shared/tags.js';
import { LOT_KINDS, lotStacks, lotHas, lotLabel } from '../shared/lot.js';
import { tierProgress, variantsOf } from '../shared/model.js';
import { ICONS } from './icons.js';
import { money, signed } from './money.js';
import { artForVariant } from './thumb.js';
// What is on a van, shared with the supplier so the two cannot disagree about
// how many eggs are coming — see client/orders.js.
import { comingByItem, comingWhy } from './orders.js';
import { deptOf, deptsIn, deptStrip, inDept } from './aisles.js';

/**
 * Group labels are ours, not the database's — but they are about to be printed
 * into a `title` attribute, and one of them is built from an authored crop name
 * away. Escaping here costs nothing and does not have to be re-argued later.
 */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/**
 * What this player has in their hands, off the snapshot — the same field the
 * HUD prints "carrying 6x bread" from, because a second copy on this side is
 * one that goes stale the tick somebody takes it off you.
 */
const carrying = (ui) => (ui.state?.players ?? [])
  .find((p) => p.id === ui.net.myId)?.carry ?? null;

/**
 * What the shop MAKES rather than buys.
 *
 * `buyStock` has refused a recipe output for as long as appliances have existed,
 * so this is the difference between "there is nothing on this board yet, order
 * some" and "there is nothing on this board yet, and the kitchen is the only
 * thing that will ever change that". Both the board rows and the item list ask
 * it, and they used to answer differently — the list promised a van for salsa.
 */
const craftedItems = (ui) => new Set((ui.catalog.recipes ?? []).map((r) => r.output_id));

/** How each kind of fixture shows up in its own menu. */
const FIXTURE_ICON = {
  shelf: ICONS.shelf, freezer: ICONS.freezer, warmer: ICONS.warmer,
  checkout: ICONS.checkout, plot: ICONS.plot, station: ICONS.station,
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
 * The same verb as one square in a row of them.
 *
 * Five verbs a line each is still five lines of a pinned foot, on a panel
 * 214px wide — and they are the most familiar thing on this menu. The same
 * five, in the same order, on every fixture in the game: once you have moved
 * one shelf you are reading the label to find the icon you already know.
 *
 * So the label comes off and the tooltip carries it, exactly the way `.tabs`
 * above already trades four words for four pictograms on a panel this narrow.
 * `title` is the whole name AND its explanation, because a tooltip has room
 * for the sentence a pinned row could not afford.
 *
 * What does NOT come off is the number. A price and a count are the two things
 * an icon genuinely cannot say, and they are the two you decide on — `$120`
 * and `5` stay, as a badge.
 *
 * Nor does the word, and that is the correction to a first pass that dropped
 * it. A tooltip is a hover, and half this game is played with a finger — so
 * icon-plus-`title` is a label on a desktop and five unlabelled glyphs on a
 * phone. `short` is a one-word caption under the icon, exactly what the build
 * bar does with `.tool .nm` and for exactly this reason. The tooltip keeps the
 * whole sentence; the caption keeps the verb.
 *
 * `data-act` is unchanged, so every one of these wires up exactly as the rows
 * did: this is a different shape for the same button, not a different button.
 */
export const actIcon = (id, icon, name, sub, short,
  { danger = false, off = false, armed = false, on = false, right = '', key = '' } = {}) => `
  <button class="fx-verb${off ? ' off' : ''}${danger ? ' danger' : ''}${armed ? ' armed' : ''}${on ? ' on' : ''}"
    ${off ? 'disabled' : `data-act="${id}"`}
    title="${esc(sub ? `${name} — ${sub}` : name)}" aria-label="${esc(name)}">
    ${right ? `<span class="have">${esc(right)}</span>` : ''}
    ${key ? `<span class="kb">${esc(key)}</span>` : ''}
    <span class="ico">${icon}</span>
    <span class="nm">${esc(short)}</span>
  </button>`;

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
  // ...and what you typed belongs to the list you typed it into. Aiming at
  // another unit starts with the whole catalogue again rather than with whatever
  // you were hunting for on the last one — and so does arriving from a menu that
  // is not a fixture at all, or the supplier's search would follow your finger
  // onto a shelf and hide most of it.
  const arrived = ui._fxTabOn !== on || ui.openPanel !== 'fixture';
  ui._fxTabOn = on;
  // ...and the tab follows you between units of the SAME kind. Comparing shelf
  // to shelf is the entire reason you open a second one — what is on it, what
  // it is kept for, what it costs to run — and starting at the front every time
  // meant the answer was two presses away on every unit after the first. It has
  // to be by kind rather than always: a plot's third tab is not a shelf's third
  // tab, so carrying an index across kinds lands you on a page you did not ask
  // for. (`at` below clamps as well, which stops a shorter menu going blank; the
  // clamp is not the rule, it is the floor under it.)
  if (ui._fxTabKind !== f.kind) { ui._fxTabKind = f.kind; ui._fxTab = 0; }
  // ...and arriving is also what puts the caret in the box when there is one —
  // see `showFilter`. A redraw of the unit you are already looking at must not,
  // or the tick behind the menu takes focus off whatever you moved to.
  if (arrived) { ui.clearFilter(); ui._filterFresh = true; }
  // The aisle goes with it. It is a narrowing of a list, exactly as the query
  // is, so arriving at another unit with `frozen` still chosen would be a shelf
  // showing eight of forty items with the reason two presses off screen.
  if (arrived) ui._fxDept = null;

  ui.openPanel = 'fixture';
  // A fixture menu is not a section, so nothing on the rail is open.
  ui.rail.setOpen(null);
  // The whole layout record is kept, not just its id: turning something
  // re-mints its id (it becomes a fresh placement), and the menu should stay
  // open on the thing that is still sitting right there on that tile.
  // Through the setter, so the world marks which prop this menu is about —
  // the panel names it, and the shop floor is where you are looking.
  ui.setFixtureRef(f);
  // ...and whoever's menu was open before this one is no longer the subject, so
  // their ring goes. A hire's marker means "this menu is about them" and nothing
  // else — unlike a fixture's, which doubles as the build selection R and M act
  // on and is meant to outlive the panel.
  ui.setWorkerRef(null);
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
  //
  // `find` is what the rows ARE, in one plural noun, and it is only ever the
  // placeholder in the search box: "search items…" over what a shelf is kept
  // for. The label cannot do that job — a heading is a sentence about the
  // fixture ("Keep it for", "Sow it with") and reads as nonsense with `search`
  // in front of it.
  const groups = [];
  const group = (label, icon, rows, find) => {
    if (rows?.length) groups.push({ label, icon, rows, find });
  };

  // What to plant belongs to the plot you're stood at, not to a menu of its own
  // three icons away. It sets the same one seed the wheel does — the choice is
  // the player's, not the plot's — but this is where you are when you want it,
  // and at an empty bed it outranks moving or selling the thing.
  // A ripe bed offers no seeds: picking one there would throw the harvest away.
  if (f.kind === 'plot' && !live?.ready) {
    group(live?.crop_id ? 'Sow something else' : 'Sow it with', ICONS.seeds,
      seedRows(ui, f, live), 'seeds');
  }

  // Anything that holds stock gets the same treatment a bed gets: what goes in
  // it is decided at the thing itself. A shelf's answer is a standing one
  // rather than a single sowing, so it also gets to say how eagerly the shop
  // keeps that promise — which is the difference between "we sell milk here"
  // and "we are never out of milk".
  if (holdsGoods(kind)) {
    // Built once and shown twice. The shortlist is a *selection* of these rows,
    // not a second list about the same items — see `quickRows`.
    const items = stockRows(ui, f, live);
    // In front of the full list, because it is the answer for almost every
    // shelf almost every time: the whole catalogue is what you open when the
    // shortlist did not have it. No `find`, and none needed — `QUICK_ROWS`
    // keeps it under the line the search box appears at, on purpose.
    group('Quick pick', ICONS.quick, quickRows(ui, items));
    group(live?.assigned?.length ? 'Kept for' : 'Keep it for', ICONS.crate, items, 'items');
  }

  // What an appliance is set to make. The same argument the shelf above makes:
  // what a thing is FOR is decided at the thing, and for a machine that knows
  // four recipes and runs one, it is the only decision there is.
  if (kind === 'station') {
    group('Set it to make', ICONS.station, recipeRows(ui, f, live), 'recipes');
  }

  // Every standing decision about THIS unit rather than about its design — the
  // refill order, the shop hand and the switches, under one heading each. See
  // `settingRows` for why they stopped being three tabs.
  //
  // A tab and a list rather than more icons in the foot, and the reason is that
  // the foot is a FIXED row you learn the shape of — five pictograms in the same
  // order on every fixture in the game. A set that grows is the opposite of
  // that: the sixth switch would push the row into two, and by the tenth nobody
  // could find any of them. A list has room for the sentence each one needs, and
  // adding the next is a row in `MODIFIERS` rather than a decision about layout.
  group('Settings', ICONS.settings, settingRows(ui, f, live));

  // A shape is free and keeps whatever is on it, so it is a browse rather than a
  // decision — which is exactly what belongs in the scrolling half. One shape is
  // not a choice, so a kind nobody has drawn a second design for gets no tab.
  const styles = styleRows(ui, f);
  if (styles.length > 1) group('Shape', ICONS.fixtures, styles, 'shapes');

  group('More of these', ICONS.build, moreOfTheseRows(ui, f), 'deals');

  // ---- the head: what it is ------------------------------------------------
  const parts = [`<div class="pnl-head">${fixtureDetail(ui, f, live)}</div>`];

  // ---- the middle: the long half, tabbed once there is more than one --------
  //
  // Tabs by the same rule sections use (`tabGroups` in ui.js): two or more
  // groups earns them, one does not. Forcing tabs on a till — which has only
  // ever had shapes to show — would hide three rows behind a click each.
  const rows = [];
  const at = Math.min(ui._fxTab ?? 0, Math.max(0, groups.length - 1));
  // Tabs sit OUTSIDE the scroller — they choose what it holds, so scrolling
  // them away leaves you in a list with no way back to the one you wanted.
  if (groups.length > 1) {
    parts.push(`<div class="tabs">${groups.map((g, n) => `
      <button class="tab${n === at ? ' on' : ''}" data-fxtab="${n}" title="${esc(g.label)}"
        aria-label="${esc(g.label)}">${g.icon}</button>`).join('')}</div>`);
  }
  // The one pane that scrolls, and it has to be a real element rather than
  // whatever is left over between two sticky ones — see `#panel-body.paned`.
  // Emitted even when empty so the layout does not change shape on a fixture
  // that happens to have nothing to list.
  const mid = [];
  // Whether the search box is up, which is decided here and applied after
  // `showPanel` — that hides it for every menu on principle, so a fixture can
  // never inherit the supplier's.
  let filterable = false;
  if (groups.length) {
    const open = groups[at];
    // ...and under them, the aisle. See `deptStrip`: a list of every item in the
    // catalogue is a list you arrive at knowing which DEPARTMENT you came for,
    // because the thing that sent you here is the demand meter, and that is what
    // the meter is made of. Emitted next to the tabs and outside the scroller
    // for the same reason they are.
    const depts = deptsIn(open.rows);
    const dept = depts.includes(ui._fxDept) ? ui._fxDept : null;
    if (depts.length > 1) parts.push(deptStrip(depts, dept));
    const aisle = inDept(open.rows, dept);
    // Search once a tab is long enough to get lost in, at the same eight-row
    // line `paintSection` draws it at and for the same reason: a box over five
    // rows costs more panel than it saves. What a shelf is kept for is the case
    // that asked for it — every item in the catalogue, in one list, one row
    // longer every time anybody authors a tomato. The rule is on the LENGTH of
    // the open tab rather than on a flag per group, so the next long list
    // somebody writes in here gets a search box without knowing about one.
    //
    // Measured on the list AFTER the aisle, because that is what is on screen:
    // three rows of produce with a search box over them is the box costing more
    // than it saves, which is the rule this line already holds everywhere else.
    filterable = aisle.length >= 8;
    // A filter you cannot see the cause of is worse than none: a tab that just
    // got short takes its box away, and must take the query with it.
    if (!filterable && ui.query) ui.clearFilter();
    const shown = filterable ? ui.applyFilter(aisle) : aisle;
    if (filterable) ui.el.search.placeholder = `search ${dept ?? open.find ?? 'this'}…`;
    // Named above its rows even with the tabs up, because an icon row is a
    // shape you learn and a heading is a thing you read — and on first open
    // nobody knows which pictogram is the seed one.
    mid.push(`<div class="sep">${esc(dept ? `${open.label} — ${dept}` : open.label)}</div>`);
    // One list, numbered once: `wireRows` binds by index, so two lists each
    // starting at zero would hand the seed picker's clicks to the shape picker.
    // Which is also why the FILTERED list is the one both numbered and wired —
    // indices into the unfiltered rows would fire the wrong item the moment you
    // typed anything.
    mid.push(shown.length ? shown.map((r, i) => ui.rowHtml(r, i)).join('')
      : '<div class="foot">Nothing matches that.</div>');
    rows.push(...shown);
  }
  parts.push(`<div class="pnl-mid">${mid.join('')}</div>`);

  // ---- the foot: what you can do about it ----------------------------------
  //
  // One row of icons, not five rows of prose, and that is the price of being
  // pinned: every line the foot takes is a line the scrolling half does not
  // get. These five are also the most familiar thing on the menu — the same
  // five, in the same order, on every fixture in the game — so past the first
  // shelf you are reading a label to find an icon you already know.
  //
  // The sentence each one used to carry moves into its tooltip, which has room
  // for the whole of it rather than the clipped half a 214px row could show.
  // See `actIcon` for what deliberately does NOT move: the price and the count.
  const foot = [];

  // The keys are on the buttons for the reason every other key in the game is on
  // its button: a shortcut nothing names is a shortcut for whoever wrote it. Both
  // of these work on whatever this menu is open on, wherever the pointer is —
  // see `rotateSelected` and `moveSelected`.
  foot.push(actIcon('move', ICONS.move, 'Move it',
    'Picks it up with everything on it. Nothing shifts until you set it down.', 'Move', { key: 'M' }));

  if (FIXTURES[kind]?.rotates) {
    // Which side a thing faces means something different for each of them, and
    // it is the reason to turn it at all — so the tooltip says the actual
    // reason. It costs nothing to be specific in a tooltip.
    const why = {
      checkout: 'Quarter turn. Sets where you serve and which way the queue runs.',
      station: 'Quarter turn. Sets which side you load it from.',
    }[kind] ?? 'Quarter turn. Sets which aisle shoppers browse it from.';
    foot.push(actIcon('rotate', ICONS.rotate, 'Rotate', why, 'Rotate', { key: 'R' }));
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
    foot.push(actIcon('upgrade', ICONS.tierup, 'Upgrade',
      afford ? blurb : `${blurb} You cannot afford it yet.`, 'Upgrade',
      // A tier that is purely cosmetic still costs nothing, and `$0` in the
      // price column reads as a broken number rather than as good news.
      { off: !afford, right: next.cost > 0 ? money(next.cost) : 'free' }));
  }

  // Straight under Upgrade, because it is the same ladder and the pair reads as
  // one control. It only appears on something that has actually been climbed —
  // a Standard shelf showing a greyed Downgrade would put a dead square on
  // every fixture in the shop to serve the few that are not on rung one.
  const back = prevTier(ui, f);
  if (back) {
    foot.push(actIcon('downgrade', ICONS.tierdown, 'Downgrade',
      `Back to ${back.name} — ${tierBlurb(back)} Half of that rung back, and it keeps its stock.`,
      'Downgrade', { right: back.refund > 0 ? signed(back.refund) : '' }));
  }

  const holds = contentsOf(ui, f, live);
  if (holds.n > 0) {
    foot.push(actIcon('empty', ICONS.empty, 'Empty it', holds.blurb, 'Empty', { right: `${holds.n}` }));
  } else if (holdsGoods(kind) && live?.stacks?.length) {
    // The labels are what was last on each board; what it is *kept* for is a tab
    // above and survives this. This one keeps its sub-line, because "take the
    // labels off" does not say WHICH — and on a shelf that is also kept for
    // something, not saying so is the menu looking like it will undo both.
    const labels = live.stacks.map((k) => ui.itemName(k.item_id)).join(', ');
    foot.push(actIcon('empty', ICONS.label, 'Take the labels off',
      live.assigned?.length
        ? `Last held ${labels}. It stays kept for ${live.assigned.map((id) => ui.itemName(id)).join(', ')}.`
        : `Still labelled ${labels}. Clear them and anything can go on.`,
      // Not "Label" — that reads as a verb for putting one ON, which is the
      // opposite of what this does and is a tab away.
      'Unlabel'));
  }

  // A greyed square says nothing about why, and this is the one verb people
  // press and get refused — so the reason IS the tooltip when there is one.
  foot.push(actIcon('remove', ICONS.remove, kind === 'station' ? 'Sell it back' : 'Remove it',
    blocked ?? 'Half of what it cost back.',
    kind === 'station' ? 'Sell' : 'Remove',
    { danger: true, off: !!blocked, right: blocked ? '' : signed(refund) }));

  parts.push(`<div class="pnl-foot"><div class="fx-verbs">${foot.join('')}</div></div>`);

  // Which unit, and which tab of it. Reserving an item or picking a shape
  // redraws the whole menu and must keep your place in a list that can run to
  // forty items; changing tab or aiming at another shelf must not.
  ui.showPanel(`${FIXTURE_ICON[kind] ?? ICONS.crate} ${ui.fixtureName(f)}`, parts.join(''),
    `fixture:${f.id}:${at}:${ui.query}:${ui._fxDept ?? ''}`);
  // After `showPanel`, which hides it — see the note there.
  ui.showFilter(filterable);
  wireFixtureMenu(ui, f, live);
  if (rows.length) ui.wireRows(rows);
  ui.el.panelBody.querySelectorAll('[data-dept]').forEach((el) => {
    // The same press the icon tabs get, and it clears the query for the same
    // reason: each list is searched on its own terms, and carrying "carrot" into
    // Frozen leaves you looking at an empty pane wondering which of the two
    // narrowings emptied it.
    el.onclick = () => {
      ui._fxDept = el.dataset.dept || null;
      ui.clearFilter();
      showFixture(ui, f);
    };
  });
  ui.el.panelBody.querySelectorAll('[data-fxtab]').forEach((el) => {
    // Redrawn rather than shown/hidden, because the rows are live: a tab built
    // once would still be offering to sow a bed that has since been harvested.
    // The query goes with the tab: each list is searched on its own terms, and
    // carrying "carrot" onto Shape would leave you looking at an empty pane.
    el.onclick = () => {
      ui._fxTab = Number(el.dataset.fxtab);
      ui.clearFilter();
      showFixture(ui, f);
    };
  });
}

/**
 * The recipe an appliance is set to, resolved the same way the server resolves
 * it: whatever the snapshot says, and failing that the first one the machine
 * knows, because a machine nobody has chosen for is running its first recipe.
 *
 * Two spellings of "which recipe is this making" is a menu that names one thing
 * while the bays over the machine draw another.
 */
function stationRecipe(ui, f, live) {
  const mine = (ui.catalog.recipes ?? []).filter((r) => r.station === f.station);
  return mine.find((r) => r.id === live?.recipe) ?? mine[0] ?? null;
}

/**
 * What this appliance could be making, as pickable rows.
 *
 * A machine knows several recipes and runs ONE, so this is a picker rather than
 * a list of checkboxes — the shape a seed picker takes, not the shape a shelf's
 * reservations take. Pressing a row is the whole decision: the hopper resizes
 * to it, the shop starts buying for it, and what the machine will and won't
 * take in your hands changes with it.
 *
 * Each row prints its own ingredients, because the choice IS the ingredients —
 * "Fresh Salsa" over "Berry Smoothie" is a decision about whether you have
 * tomatoes. It costs a line and saves opening something else to find out.
 */
function recipeRows(ui, f, live) {
  const here = stationRecipe(ui, f, live)?.id ?? null;
  const batches = live?.batches ?? 1;
  return (ui.catalog.recipes ?? [])
    .filter((r) => r.station === f.station)
    .map((r) => ({
      icon: ICONS.station,
      name: r.name,
      // Per batch, not per hopper. It is the number that decides whether the
      // thing can run at all, and the hopper's ceiling is on the head above.
      sub: `${r.inputs.map((i) => `${i.qty}× ${ui.itemName(i.item_id)}`).join(' + ')} → ${r.output_qty ?? 1}× ${ui.itemName(r.output_id)}`,
      facets: r.inputs.map((i) => ui.itemName(i.item_id)),
      right: `${(r.minutes ?? 0)}m`,
      picked: r.id === here,
      // The one already set is dead rather than absent, the way the shape picker
      // treats the shape you are already wearing: a row that vanished when you
      // pressed it would leave the list a different length every time you looked.
      run: r.id === here ? null
        : () => ui.net.send('station-recipe', { stationId: f.id, recipeId: r.id }),
    }));
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
    // Each shape wearing its own shape, the same picture the palette's shape
    // card draws — "Wall corner" and "Wall corner (other way)" are one word in
    // two spellings otherwise, and a column of identical glyphs is the list
    // saying nothing about the only thing being chosen here. `icon` stays as
    // the fallback for a shape nobody has drawn a model for.
    art: artForVariant(v),
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
  const home = shelfKind(f.kind);
  // A LIST now, and every row is a checkbox rather than a picker. The same rows
  // in the same order — what changed is that pressing one toggles it instead of
  // replacing whatever was there.
  const kept = live?.assigned ?? [];
  // How many kinds this unit has boards for, and how many are spoken for. Both
  // come off the snapshot: `boards` is read from the model at this fixture's
  // tier, which the client has no ladder to work out for itself.
  const boards = live?.boards ?? 1;
  const onIt = new Set((live?.stacks ?? []).map((k) => k.item_id));
  const committed = new Set([...kept, ...onIt]);
  const full = committed.size >= boards;
  // Where else this is already spoken for — so nobody reserves the same thing
  // on three shelves and wonders why two of them stay empty.
  //
  // TWO answers, because the shop now has two ways of keeping a thing somewhere
  // and only one of them was a tick. `Game.homeShelves` gives an item one unit,
  // and a board simply HOLDING it is a home just as a reservation is — so a row
  // that read as free ("nobody has kept a shelf for that") was offering a board
  // the shop would never stock, which is the panel promising what the stocker
  // will not do. Kept separate rather than merged into one set because they are
  // different sentences: one is a decision somebody made, the other is where
  // the goods happen to be.
  const others = (ui.state?.shelves ?? []).filter((s) => s.id !== f.id);
  const keptElse = new Set(others.flatMap((s) => s.assigned ?? []));
  const heldElse = new Set(others.flatMap((s) => (s.stacks ?? []).map((k) => k.item_id)));
  const crafted = craftedItems(ui);
  // ...and of those, the ones the shop can actually make. A recipe names its
  // appliance (`RecipeSchema.station`) and the shop either owns one of those or
  // it does not — so an item whose machine you have not bought is not a board
  // waiting to be filled, it is a board that will sit empty until you buy a
  // fryer. Nothing said so: `restock` cannot order a recipe output (`buyStock`
  // refuses one) and no chef can produce it, so ticking it was the one choice in
  // this panel with no outcome at all in either direction.
  const owned = new Set((ui.state?.stations ?? []).map((s) => s.station));
  const needsMachine = new Map();
  for (const r of ui.catalog.recipes ?? []) {
    // Two recipes for one output and one machine you own is an output you can
    // make, whichever order the rows come in — so owning it always wins.
    if (owned.has(r.station)) needsMachine.set(r.output_id, null);
    else if (!needsMachine.has(r.output_id)) needsMachine.set(r.output_id, r.station);
  }
  const machineName = (id) => (ui.catalog.fixtures ?? []).find((x) => x.id === id)?.name ?? id;
  // What this particular unit would hold of it — tier included, and DIVIDED by
  // how many ways it is being shared, because that is the number the shop
  // actually fills to. Showing the undivided one would promise 12 on a shelf
  // the stocker stops at 4.
  const capMult = tiersOf(ui, f)[tierOf(ui, f) - 1]?.capacity_mult ?? 1;
  const share = Math.max(1, committed.size || 1);
  // What is already on its way, so a row can say it the way the supplier does
  // rather than sending you to buy something you have just bought.
  const coming = comingByItem(ui);

  const rows = (ui.catalog.items ?? [])
    .filter((it) => homeKind(it) === home)
    .map((it) => {
      const on = kept.includes(it.id);
      const here = (live?.stacks ?? []).find((k) => k.item_id === it.id) ?? null;
      // Ticking this would need a board, and there is not one. Said as a reason
      // rather than a silently dead row — "every board is taken" is a fact about
      // the shelf you can act on, and the row that is greyed out for a different
      // reason (somewhere else has it) already says so.
      const noRoom = !on && !here && full;
      // What the SHOP has of it, which is a different question from what this
      // unit has and the one you are actually answering here: a board is worth
      // giving to something there is stock for. Split in two because the halves
      // mean opposite things — on the shelves is already working, in crates and
      // in hands is paid for and earning nothing.
      const shelved = ui.heldOf(it.id);
      const spare = ui.spareOf(it.id);
      const inbound = coming.get(it.id)?.qty ?? 0;
      // The state of this row in one sentence, or null when there is nothing to
      // say and the tags may as well have the line. Pulled out of the `sub`
      // chain because Quick pick prints its own reason and must not talk over
      // this one — a shelf that already has the thing on it outranks any
      // argument for putting it there.
      // No machine for it is the FIRST thing said, before anything about boards
      // or vans, because it is the only one that means nothing will ever arrive.
      // It is said on a ticked row too — the appliance can be sold back under a
      // reservation you made when you had one, and "the kitchen makes it" over a
      // shop with no kitchen is the panel lying about a board that will never
      // fill.
      const missing = needsMachine.get(it.id) ?? null;
      const note = missing
        ? `you have no ${machineName(missing).toLowerCase()} to make this`
        : on
        ? (here ? `kept for this — ${here.qty} on this board`
          // …and a van is never due for something the shop cannot buy. `buyStock`
          // refuses a recipe output, so an empty board kept for salsa is waiting
          // on an appliance and a stocker, and the delivery wording sent you to
          // the supplier to look for an order that could not exist.
          : (crafted.has(it.id) ? 'kept for this — the kitchen makes it'
            : 'kept for this — a van is due'))
        : (here
          ? 'on it, but not kept — it will sell down and not be refilled'
          : (noRoom
            ? `no board free — this ${f.kind} holds ${boards}`
            : (keptElse.has(it.id)
              ? 'another shelf is already kept for this'
              // Not a tick, but the shop's own answer to where this lives. Says
              // what ticking would DO, because it is not a refusal: a
              // reservation outranks the home rule, so this is the one way to
              // give something a second board on purpose.
              : (heldElse.has(it.id)
                ? 'another shelf already stocks this — tick to keep a second board for it'
                : null))));
      return {
        id: it.id,
        // Which aisle it belongs to, so the strip can sort forty items into the
        // twelve buckets the demand meter already draws. See client/aisles.js.
        dept: deptOf(it),
        // Where it comes FROM, at a glance, on the one part of the row you do
        // not have to read. Every row carried a crate, which is true of most of
        // the catalogue and a lie about the rest: a recipe output never arrives
        // on a van at all (`buyStock` refuses one), so the difference between
        // "order this" and "make this" is the difference between a decision and
        // a job — and it was only ever said in the note, which most rows have
        // already spent on something else.
        //
        // An icon rather than a tab, deliberately, and docs/ordering.md's last
        // gotcha is the argument: Frozen/Fresh/Keeps organised the whole
        // catalogue around a fact about each item, and left three flat alphabets
        // to scroll. Splitting this list in two would do it again — you would
        // have to know which half a thing is in before you could look for it,
        // and the answer is what you came here to find out.
        icon: crafted.has(it.id) ? ICONS.station : ICONS.crate,
        name: it.name,
        note,
        // How many the shop has and how many are coming, in the column the
        // supplier already puts that number in and in the same two shapes: a
        // dash for none, and what is on a van hung off it as `+6` rather than
        // taking a second column.
        //
        // It counts MORE than the supplier's does, though — crates and hands as
        // well as boards — and the two are different on purpose. Over there the
        // question is "is a shelf running thin", which a crate in the yard has
        // not fixed. Here it is "what should this board be for", and a crate in
        // the yard is the best answer there is: it is already bought.
        stock: shelved + spare,
        spare,
        count: `${shelved + spare || '<i class="none">–</i>'}${inbound ? `<i class="coming">+${inbound}</i>` : ''}`,
        // Where the count in the column came from, but only when the answer is
        // interesting: goods in crates are the half you cannot see from the
        // shop floor and the half that argues for giving this a board. Tags
        // otherwise, which is what the row has always said when it had nothing
        // to report.
        sub: note ?? (spare > 0
          ? `${spare} in crates, ${shelved} on the shelves`
          : (it.tags ?? []).join(', ')),
        // Search reaches the tags whatever the sub-line ended up saying. It is
        // the row that has stopped printing them that needs this most: a shelf
        // kept for cheese elsewhere says so instead of listing `dairy`, and
        // typing `dairy` would then hide the very rows you were looking for.
        facets: it.tags ?? [],
        // What a board of it holds once this one is ticked, which is the number
        // that changes as you tick more. Worked out against what the share WOULD
        // be, so the figure you read is the figure you are choosing.
        right: `${Math.max(1, Math.floor(((it.stack ?? 1) * capMult)
          / Math.max(1, on ? share : share + (here ? 0 : 1))))}×`,
        picked: on,
        // Faded is for a row with nothing to press. Somewhere else keeping this
        // is not that — ticking here is the sanctioned way to give a thing a
        // second board — so it gets the lighter of the two weights.
        dim: noRoom || !!missing,
        soft: !on && !here && (keptElse.has(it.id) || heldElse.has(it.id)),
        // Every row is live, including the ticked ones — pressing a ticked row
        // unticks it, which is what a checkbox is. The dead rows are the two
        // with no outcome either way: no board to give it, and no machine to
        // make it. A ticked row survives the second one on purpose — selling the
        // fryer must leave you able to untick the board you kept for chips.
        run: (noRoom || (missing && !on)) ? null
          : () => ui.net.send('assign', { shelfId: f.id, itemId: it.id, on: !on }),
      };
    });

  // Handing the whole unit back, at the top — and only once there is something
  // to hand back, because "anything at all" is what a shelf already is by
  // default. It clears every box rather than one, which is why it stays a row of
  // its own rather than becoming a checkbox like the rest.
  if (kept.length) {
    rows.unshift({
      icon: ICONS.label,
      name: 'Anything at all',
      sub: kept.length > 1
        ? `Stop keeping it for those ${kept.length}. Your crew fill it with whatever sells.`
        : 'Stop keeping it for one thing. Your crew fill it with whatever sells.',
      run: () => ui.net.send('assign', { shelfId: f.id, itemId: null }),
    });
  }
  return rows;
}

/**
 * How many rows a shortlist is allowed to be.
 *
 * Under the eight the search box appears at, and that is the whole rule: a list
 * long enough to need searching has stopped being a shortlist. Eight itself
 * would put a box over it, since `filterable` is `>= 8` — the shortlist would
 * have grown the exact control it exists to save you. Even, because this is two
 * halves and an odd cap quietly favours whichever half goes first.
 */
const QUICK_ROWS = 6;

/**
 * The shortlist: half what sells, half what you are sitting on.
 *
 * Deciding what a board is for means scrolling forty items to find the two you
 * would ever pick, and the two you would ever pick are answers to two different
 * questions. What does the town buy — that is the shelf earning. And what have
 * I already got — a crate of your own eggs on the pad is money spent that is
 * not on a board, and it is the *only* reason to keep a shelf for something
 * nobody is asking for yet.
 *
 * Interleaved rather than concatenated, so the tab is not "the good half and
 * then the other one": every other row swaps the question, and a thing that
 * wins both only appears once, at the higher of its two places.
 *
 * Built from `stockRows` rather than beside it — these ARE those rows, ticking
 * one does exactly what ticking it over there does, and a second row builder
 * for the same checkbox is a second set of rules about what may go where.
 * Copies, though: the reason line is this tab's own, and mutating the shared
 * object would rewrite the list it was borrowed from.
 */
function quickRows(ui, rows) {
  // Only what you could actually press. A dead row is worse here than in the
  // full list: there it is a list you are reading, and this is a list of
  // suggestions — one that cannot be taken is not a suggestion.
  const live = rows.filter((r) => r.id && r.run);
  const sold = ui.state?.stats?.byItem ?? {};

  // What sells. Today's own till first, because "popular" in a shop with
  // eleven shelves means popular HERE — but the day resets at midnight and a
  // shop that has sold nothing yet still has to answer, so the world's own
  // appetite is behind it and the sticker price is behind that. Every term is
  // a real fact about the item; none of them is a guess at the others.
  const popular = [...live].sort((a, b) => (
    (sold[b.id] ?? 0) - (sold[a.id] ?? 0)
    || ui.heatFor(ui.itemById(b.id) ?? {}) - ui.heatFor(ui.itemById(a.id) ?? {})
    || (ui.itemById(b.id)?.base_price ?? 0) - (ui.itemById(a.id)?.base_price ?? 0)
  ));
  // ...and what you have. Nothing with none of it: "0 in the shop" is not a
  // reason to do anything, and half a tab of them would be half a tab of noise.
  const stocked = live.filter((r) => r.stock > 0).sort((a, b) => b.stock - a.stock);

  const out = [];
  const seen = new Set();
  const take = (list) => {
    while (list.length) {
      const r = list.shift();
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      return;
    }
  };
  while (out.length < QUICK_ROWS && (popular.length || stocked.length)) {
    take(out.length % 2 === 0 ? popular : stocked);
    // One of the two ran dry — the other finishes the list rather than leaving
    // a shortlist of three on a shop with forty items in it.
    if (!popular.length) take(stocked); else if (!stocked.length) take(popular);
  }

  return out.map((r) => {
    const item = ui.itemById(r.id) ?? {};
    const n = sold[r.id] ?? 0;
    // Why this row is here — the same rule the supplier's tabs follow: a list
    // that sorts you into a pile and does not say which pile is the scrolling
    // problem one level up. `note` outranks all of it: that the thing is
    // already on this board, or kept somewhere else, is news and this is not.
    const why = r.note ?? (
      n > 0 ? `${n} sold today`
        : r.spare > 0 ? `${r.stock} in the shop, ${r.spare} of it in crates`
          : r.stock > 0 ? `${r.stock} on the shelves already`
            : ui.heatFor(item) >= 1.25 ? 'in demand right now'
              : `${money(item.base_price ?? 0)} each`);
    // The heat pill only here. It is the one number on the row that is about
    // the world rather than the shop, which is worth 40px on a shortlist and
    // is noise repeated down forty rows of the full list.
    return { ...r, sub: why, heat: ui.heatPill(item) };
  });
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

/**
 * Every switch a unit can carry, and which kinds carry it.
 *
 * A table because this is the shape that grows: a modifier is a boolean about
 * one placement, the server has a verb for it, and the menu should need nothing
 * but a row here. `on` reads the live snapshot rather than the layout, because
 * a switch changes while the shop stands still.
 */
const MODIFIERS = [
  {
    id: 'boh',
    kinds: STOCK_KINDS,
    icon: ICONS.crate,
    on: (live) => live?.boh === true,
    name: (on) => (on ? 'In the back' : 'On the shop floor'),
    sub: (on) => (on
      ? 'Crew-only. Shoppers cannot see it, the chef takes ingredients from here before stripping a shelf people are buying from, and the shop fills it with what the nearest appliances need.'
      : 'Shoppers browse it. Tap to make it crew-only storage — a kitchen is a room you mark out, not furniture you buy.'),
    verb: 'build-boh',
  },
];

function modifierRows(ui, f, live) {
  return MODIFIERS.filter((m) => m.kinds.includes(f.kind)).map((m) => {
    const on = m.on(live);
    return {
      icon: m.icon,
      name: m.name(on),
      sub: m.sub(on),
      picked: on,
      // Tapping a switch flips it, so there is no dead row here — unlike a
      // picker, where the one you are already on has nothing to do.
      //
      // Through `withBuildMode` for the same reason every verb in the foot goes
      // through it: the server gates these on build mode and this menu opens
      // with or without it, so the press has to carry the mode in rather than
      // bounce off it. Sent raw it comes back "not in build mode" and the row
      // simply does nothing, which reads as a dead button.
      run: () => ui.withBuildMode(() => ui.net.send(m.verb, { id: f.id, on: !on })),
    };
  });
}

/**
 * Whether the shop hand may rearrange this unit.
 *
 * A picker rather than a switch in `MODIFIERS`, for two reasons. The switches
 * go through `withBuildMode` because the server gates them on it, and this one
 * is not gated — it is the same kind of standing instruction the refill order
 * is, taken stood in front of the shelf. And it reads better as two sentences
 * than as one label that changes: "leave it alone" is worth saying in full,
 * because the whole point of the row is that the shop will otherwise act on
 * this shelf without asking.
 */
const HANDS = [
  {
    on: true,
    name: 'Let them rearrange it',
    sub: 'Boards nothing sells off are cleared to the stockroom, and a split one is merged.',
  },
  {
    on: false,
    name: 'Leave it alone',
    sub: 'Nothing comes off this unit but a sale. Refilling it is unaffected.',
  },
];

function handRows(ui, f, live) {
  const at = live?.managed !== false;
  return HANDS.map((h) => ({
    icon: ICONS.stocker,
    name: h.name,
    sub: h.sub,
    picked: h.on === at,
    run: h.on === at ? null
      : () => ui.net.send('shelf-hands', { shelfId: f.id, on: h.on }),
  }));
}

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
 * Everything about THIS unit that is a standing decision, under one tab.
 *
 * Three tabs before this — the refill order, the shop hand and the switches —
 * and none of them was more than three rows. A tab is a place you learn to
 * look, and three of them holding seven rows between them means the thing you
 * want is behind whichever pictogram you did not try first, on a panel where
 * every tab you add makes the rest of them narrower. They are one tab and three
 * headings now, which is the same information in the order you would read it:
 * how it gets filled, who may touch it, and what it is.
 *
 * `sep` rows rather than three lists, because that is the shape `paintSection`
 * already draws a heading with and `applyFilter` already knows to drop when you
 * type — the whole tab is under the eight-row line today, but the next switch
 * anybody adds should not have to think about that.
 */
function settingRows(ui, f, live) {
  const rows = [];
  const under = (heading, list) => { if (list.length) rows.push({ sep: heading }, ...list); };
  if (holdsGoods(f.kind)) {
    under('When it gets refilled', priorityRows(ui, f, live));
    under('The shop hand', handRows(ui, f, live));
  }
  under('Set up', modifierRows(ui, f, live));
  return rows;
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
      right: growing ? '' : money(c.seed_cost),
      // A crop carries no tags of its own — what it grows INTO does, and that is
      // what anybody typing `produce` in here is looking for. The seasons are
      // already in the sub-line and searchable from there.
      facets: ui.itemById(c.item_id)?.tags ?? [],
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
  if (holdsGoods(f.kind)) return s.shelves?.find((x) => x.id === f.id) ?? null;
  if (f.kind === 'plot') return s.plots?.find((x) => x.id === f.id) ?? null;
  if (f.kind === 'station') return s.stations?.find((x) => x.id === f.id) ?? null;
  if (f.kind === 'checkout') return s.queues?.find((x) => x.id === f.id) ?? null;
  return null;
}

/** Everything the open menu draws from, so it can redraw when any of it moves. */
export function fixtureSignature(ui, f, live) {
  return JSON.stringify([f.id, f.rot, f.tier, live, ui.state?.cash?.toFixed(0),
    ui.ownedUpgrades?.length, ui.selectedCrop, ui._season,
    // What is in your hands. Every board's Take button greys out while you are
    // holding something else, so a menu blind to this would still be offering
    // a pickup you cannot make — or refusing one you now can.
    carrying(ui)?.item_id ?? null,
    // Which tab is showing. In here because a snapshot redraw rebuilds the
    // whole panel from this function's verdict, and a signature blind to the
    // tab would let the next tick repaint the menu on the tab you had just
    // left — a press that visibly undoes itself a tenth of a second later.
    ui._fxTab ?? 0,
    // ...and what it is filtered to, for the same reason: the key is meant to
    // describe what is on screen, and a menu showing three of forty rows is not
    // the same picture as one showing forty. Both narrowings, or the next tick
    // repaints the whole list over the aisle you just chose — the same press
    // that visibly undoes itself the tab is in here to prevent.
    ui.query ?? '',
    ui._fxDept ?? '',
    // What every *other* shelf is kept for, AND what it holds. This menu says
    // which items are already spoken for elsewhere, so it has to redraw when
    // somebody else spoke for one — `live` is only ever this shelf's own row.
    // The kinds a shelf holds joined the key when a board holding something
    // started counting as its home (`Game.homeShelves`): ids only, never
    // quantities, or every sale in the shop repaints this panel.
    (ui.state?.shelves ?? []).map((s) => [...(s.assigned ?? []),
      ...(s.stacks ?? []).map((k) => k.item_id)].join('+')).join(','),
    // What is on a van, and how much more the bay will take. Both are drawn on
    // every board row now — the `+6` and how much the order button asks for —
    // and neither is anywhere in `live`, so a menu blind to them would go on
    // offering a case you have already bought until you closed and reopened it.
    // Which appliances the shop owns, because a row for something you cannot
    // make is dead and buying the fryer is what brings it back to life. Kinds
    // only — a machine mid-batch must not repaint this panel ten times a second.
    [...new Set((ui.state?.stations ?? []).map((s) => s.station))].sort().join('+'),
    (ui.state?.orders?.pending ?? []).map((o) => `${o.item_id}:${o.qty}:${o.at}:${o.onVan}`).join(','),
    ui.state?.orders?.bayRoom ?? null,
    // What the whole shop holds, which every item row now prints as a count and
    // Quick pick ranks half its list on. Shelf stock is folded to ONE total
    // rather than listed per item: this is a staleness test, not a readout, and
    // a forty-entry string rebuilt ten times a second to notice one sale is a
    // lot of work to spot something the cash figure beside it usually catches
    // anyway. Crates are listed, because there are never many and the whole
    // point of the number is that a crate turning up changes your mind.
    (ui.state?.shelves ?? []).reduce((n, s) => n
      + (s.stacks ?? []).reduce((m, k) => m + (k.qty ?? 0), 0), 0),
    (ui.state?.deliveries ?? [])
      .map((d) => lotStacks(d).map((k) => `${k.item_id}:${k.qty}`).join('+')).join(',')]);
}

/** The read-out at the top: what this particular thing is doing right now. */
function fixtureDetail(ui, f, live) {
  const line = (label, value) => `<div class="fx-line"><span>${label}</span><b>${value}</b></div>`;

  if (holdsGoods(f.kind)) {
    const stacks = live?.stacks ?? [];
    const boards = live?.boards ?? 1;

    // One row per board, and everything about that board is on it: what it is,
    // how much of it, what it sells for, and the button that takes an armful.
    //
    // The price had to come down here from the single line it used to be: a
    // unit holding three things has three prices, and one control at the top of
    // the panel could only ever have repriced one of them — silently, and not
    // necessarily the one you were looking at. But it arrived as a *second*
    // line under each board, labelled "Price", so a shelf holding three things
    // read as six rows and you had to pair them up by eye to know which price
    // belonged to which cheese. A stepper reading `− $8.50 +` does not need the
    // word Price in front of it; being on the same line as the name is what
    // says which board it is for.
    //
    // What is already in your hands, which decides whether a board will give
    // you any of what is on it. Read here rather than guessed at: the refusal
    // is the server's, and a button that offers what it cannot deliver is
    // worse than one that says why it can't.
    const held = carrying(ui);

    // What is already on a van, folded the same way the supplier folds it — the
    // same function, so the two panels cannot disagree about how many eggs are
    // coming. This is the one fact about a board you cannot get by walking over
    // and looking at it, which is why it belongs on the board rather than only
    // in the supplier: the moment you notice a shelf is bare is the moment you
    // want to know whether you already did something about it.
    const coming = comingByItem(ui);
    // Anything a recipe makes cannot be ordered at all — `buyStock` has refused
    // it for as long as appliances have existed.
    //
    // It used to get no button, on the "a button that can only error is worse
    // than no button" rule, and that rule is right about a button and wrong about
    // a HOLE. A row of three units kept for salsa, juice and skewers had no order
    // control anywhere on it, so the reading was that ordering had gone missing
    // from this menu — the question is "where is the order button", and an absence
    // cannot answer it. Disabled, saying why, is not a button that errors: it is
    // the one place the answer can be read, and it keeps the row's grid the way
    // the always-drawn Take button does.
    const crafted = craftedItems(ui);
    // How much more the yard will take. An order over this is refused by the
    // server, so the button offers a smaller one rather than a doomed one.
    // `null` is "the snapshot didn't say" and means don't clamp and don't
    // refuse — a missing field defaulted to 0 would grey out every order button
    // in the shop and blame the bay for it.
    const bayRoom = ui.state?.orders?.bayRoom ?? null;

    // Every board this unit has anything to say about: what is on it, then what
    // it is being kept for and has not arrived yet.
    //
    // Those used to be a list of rows and one line of prose — "Waiting for Garden
    // Juice, Veg Skewers, Fresh Salsa" — and the prose was the wrong shape twice
    // over. It read as a *status* when what you had just done was give three
    // boards a job, so ticking three boxes and getting a sentence looks like the
    // shelf ignored you. And it was the only thing in this menu you could not act
    // on: the reason you are looking at an empty reserved board is almost always
    // to order some, which was a button two rows further down under a different
    // heading, or to untick it, which meant going back to the item list to find
    // the box you had just ticked.
    const rows = [...stacks, ...(live?.waiting ?? []).map((w) => ({ ...w, pending: true }))];

    const boardRows = rows.map((k) => {
      const item = ui.itemById(k.item_id);
      const name = item?.name ?? k.item_id;
      // Off the wire. It used to be the stack times the tier's multiplier
      // divided by the shares — right, but a third spelling of a division the
      // sim enforces and the renderer now draws against, and three of those is
      // how a shelf starts disagreeing with the menu describing it.
      const cap = k.cap ?? null;
      // Out of HANDS, not "holding something else": hands hold three kinds now,
      // so carrying tomatoes no longer stops you taking an armful of bread.
      // The old test refused a board the server would happily have filled.
      const clash = held && !lotHas(held, k.item_id) && lotStacks(held).length >= LOT_KINDS;
      // Always drawn, disabled when there is nothing to take — an empty board
      // is a labelled one waiting on a van, and dropping the button would slide
      // that row's price stepper a button's width out of line with the others.
      const why = k.qty <= 0 ? 'Nothing on this board yet.'
        : (clash ? `Your hands are full — ${lotLabel(held, ui.catalog?.byId?.items ?? {})}.`
          : `Go and take an armful of ${name} off this board.`);
      // A board that is only a promise. Nothing has ever stood on it, so there is
      // no price to change — `setPrice` needs a stack and refuses without one, so
      // a live stepper here would be two buttons that can only error. Drawn
      // disabled rather than dropped, because the row is a grid: a missing
      // stepper slides the three buttons after it out of line with every other
      // board, and a ragged column reads as a layout bug.
      const pending = k.pending === true;

      // On its way, and when. The count hangs off the board's own number rather
      // than taking a column — the supplier settled that argument, and the two
      // numbers are not comparable anyway: one is stock you can sell this
      // second, the other is a promise.
      const due = coming.get(k.item_id) ?? null;
      const inbound = due?.qty ?? 0;

      // What to order, which is the room on this board LESS what is already
      // coming. Subtracting the van is the whole rule the restocker works to —
      // the shop should not buy what it has already bought — and a button that
      // ignored it would be the "shelf reads as bare, order another case" bug
      // with a player's finger on it instead of a stocker's.
      const room = (cap ?? item?.stack ?? 0) - k.qty - inbound;
      // Same wording the supplier's foot uses for a bay with nothing left,
      // because it covers the shop that has painted no bay at all as well —
      // which the client cannot tell apart from a full one, and which the
      // server refuses with the exact sentence either way.
      const want = Math.max(0, Math.min(room, item?.stack ?? room, bayRoom ?? room));
      const orderWhy = crafted.has(k.item_id)
        ? `${name} is made here, not delivered — set an appliance to it and a stocker brings it over.`
        : bayRoom === 0 ? 'No room at the bay for another order.'
          : room <= 0 ? (inbound
            ? `${inbound} already on the way — ${comingWhy(due)}`
            : 'This board is full.')
            : `Order ${want}× ${name} — it lands at the bay on the next van.`;

      return `<div class="fx-board${pending ? ' pending' : ''}">
        <span class="nm" title="${esc(name)}">${esc(name)}</span>
        <b class="qty"${due ? ` title="${esc(comingWhy(due))}"` : ''}>${k.qty}${cap ? `<i>/${cap}</i>` : ''}${inbound ? `<i class="coming">+${inbound}</i>` : ''}</b>
        <span class="fx-price">
          <button ${pending ? 'disabled' : `data-price="-1" data-item="${esc(k.item_id)}"`}
            title="${esc(pending ? `Nothing on this board to price yet — ${name} takes its price when it lands.` : `Charge less for ${name}`)}" aria-label="Charge less">−</button>
          <b>${pending ? '—' : money(k.price ?? 0)}</b>
          <button ${pending ? 'disabled' : `data-price="1" data-item="${esc(k.item_id)}"`}
            title="${esc(pending ? `Nothing on this board to price yet — ${name} takes its price when it lands.` : `Charge more for ${name}`)}" aria-label="Charge more">+</button>
        </span>
        <button class="fx-take fx-order"
          ${want > 0 && !crafted.has(k.item_id)
    ? `data-order="${esc(k.item_id)}" data-qty="${want}"` : 'disabled'}
          title="${esc(orderWhy)}" aria-label="Order more">${ICONS.supplier}</button>
        <button class="fx-take" ${k.qty > 0 && !clash ? `data-take="${esc(k.item_id)}"` : 'disabled'}
          title="${esc(why)}" aria-label="Take some">${ICONS.crate}</button>
        ${pending
    // Un-tick, not Empty. There is nothing on this board to strip, so the only
    // thing "get rid of it" can mean is the reservation — and `build-empty` on a
    // board with no stack is a verb with nothing to do that also needs build
    // mode. Same message the item list's checkbox sends, which is what keeps the
    // two views one decision rather than two.
    ? `<button class="fx-take fx-clear" data-unkeep="${esc(k.item_id)}"
          title="${esc(`Stop keeping a board for ${name}. Nothing is on it, so nothing moves.`)}"
          aria-label="Stop keeping it">${ICONS.remove}</button>`
    : `<button class="fx-take fx-clear" data-clear="${esc(k.item_id)}"
          title="${esc(k.qty > 0
      // Says the consequence, because the consequence is the point of pressing
      // it: without the mark a stocker walks the crate straight back on, and a
      // player who cannot see why reads it as the button not working.
      ? `Take ${name} off this shelf — ${k.qty} into a crate beside it, the board is free, `
        + 'and the shop stops restocking it unless another shelf keeps it.'
      : `Take ${name} off this shelf and free the board.`)}"
          aria-label="Take it off">${ICONS.remove}</button>`}
      </div>`;
    }).join('');

    // `Waiting for` retired here — those are rows now (`rows` above), which is
    // where every other thing you can do to a board already lived. `+6 at 14:00`
    // still gets said, on the board's own number, by the same `coming` fold: what
    // the line was for was telling "kept for juice, nothing ordered" apart from
    // "kept for juice, a van is due", and a board reading `0/12 +6` says that in
    // the column the question was asked in.
    return `<div class="fx-detail">
      ${line('Boards', `${stacks.length} of ${boards} in use`)}
      ${boardRows || line('Holding', '<i>nothing</i>')}
      ${live?.priority ? line('Refilled', live.priority > 0 ? 'first' : 'last') : ''}
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

    // The ONE recipe it is set to, with each ingredient counted against what is
    // actually in the hopper. It listed every recipe the machine knew while the
    // machine chose for itself, and that was two lists of numbers where only one
    // of them was ever going to happen. The others are a tab below, as things to
    // switch to rather than as things it might be doing.
    const recipe = stationRecipe(ui, f, live);
    const held = (id) => live?.contents?.[id] ?? 0;

    // How much of an ingredient this machine takes, computed here off the same
    // recipe and the same `batches` the server used. The bar has to say the
    // ceiling: a hopper you can keep filling is only worth filling if the game
    // tells you how far, and "1 / 1" beside a full armful reads as a machine
    // that is refusing you rather than one that is loaded.
    const batches = live?.batches ?? 1;

    const body = recipe ? `
      <div class="fx-recipe">
        <div class="fx-recipe-h">
          <span>${esc(recipe.name)}</span>
          <b>makes ${recipe.output_qty ?? 1}×</b>
        </div>
        ${recipe.inputs.map((i) => `
          <div class="fx-ing${held(i.item_id) >= i.qty ? ' ok' : ''}">
            <span>${ui.itemName(i.item_id)}</span>
            <b>${held(i.item_id)} / ${i.qty * batches}</b>
          </div>`).join('')}
      </div>` : '';

    // What is waiting to be picked up, which used only ever to be one batch and
    // so was never worth its own line. It is the reason to walk over now.
    const ready = live?.output
      ? `${live.output.qty}× ${ui.itemName(live.output.item_id)}`
      : '<i>nothing</i>';

    return `<div class="fx-detail">
      ${line('In the hopper', inside || '<i>empty</i>')}
      ${line('Making', live?.making ? ui.itemName(live.output?.item_id ?? live.making) : '<i>idle</i>')}
      ${line('Ready to collect', ready)}
      ${body || line('Set to make', '<i>no recipes yet</i>')}
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
      right: money(u.cost),
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
      } else if (what === 'downgrade') {
        send('build-downgrade', { id: f.id });
      } else if (what === 'remove') {
        send('build-remove', { id: f.id });
        ui.closePanel();
      }
    });
  });

  // Not through `withBuildMode`, unlike every verb in the foot: taking stock
  // off a shelf is shopkeeping, not building, and the server gates it on
  // standing there instead. The menu stays open — the count on this row is
  // what tells you it worked, and it drops as you arrive.
  ui.el.panelBody.querySelectorAll('[data-take]').forEach((el) => {
    el.onclick = () => send('take', { shelfId: f.id, itemId: el.dataset.take });
  });

  // Ordering is shopkeeping, not building, and it is not gated on standing
  // anywhere either — the goods land at the bay whatever you do next. So it is
  // the one control on the row that goes straight out. A refusal (no bay, no
  // cash, a full pad) arrives as a toast like every other refusal.
  ui.el.panelBody.querySelectorAll('[data-order]').forEach((el) => {
    el.onclick = () => send('buy-stock', {
      itemId: el.dataset.order, qty: Number(el.dataset.qty) || 1,
    });
  });

  // Through `withBuildMode`, unlike Take beside it: this is Empty in the foot
  // aimed at one board, and the server gates it the same way. Sent raw it comes
  // back "not in build mode" and the button reads as dead.
  ui.el.panelBody.querySelectorAll('[data-clear]').forEach((el) => {
    el.onclick = () => ui.withBuildMode(() => {
      send('build-empty', { id: f.id, itemId: el.dataset.clear });
    });
  });

  // The same square on a board that is only a promise. Straight out rather than
  // through `withBuildMode`, because this is not Empty aimed at one board — it is
  // the item list's checkbox pressed from the row it made, and saying what a
  // shelf is for was never gated on building.
  ui.el.panelBody.querySelectorAll('[data-unkeep]').forEach((el) => {
    el.onclick = () => send('assign', { shelfId: f.id, itemId: el.dataset.unkeep, on: false });
  });

  ui.el.panelBody.querySelectorAll('[data-price]').forEach((el) => {
    el.onclick = () => {
      // Which board. A unit can hold three things at three prices, so the button
      // has to name the one it is under — a `set-price` with no item would have
      // to guess, and any rule for guessing reprices the wrong cheese.
      const itemId = el.dataset.item ?? null;
      const stack = (live?.stacks ?? []).find((k) => k.item_id === itemId);
      const step = Number(el.dataset.price) * 0.25;
      const next = Math.max(0, Math.round(((stack?.price ?? 0) + step) * 100) / 100);
      send('set-price', { shelfId: f.id, price: next, itemId });
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

/**
 * The rung below, and what stepping back onto it hands you — or null at the
 * bottom. The refund is worked out here for the same reason the Remove button's
 * is: the number has to be on the button *before* it is pressed, and the server
 * computes the identical one from the identical constant.
 */
function prevTier(ui, f) {
  const at = tierOf(ui, f);
  if (at <= 1) return null;
  const tiers = tiersOf(ui, f);
  return {
    ...tiers[at - 2],
    tier: at - 1,
    refund: (tiers[at - 1]?.cost ?? 0) * FIXTURE_REFUND,
  };
}

/** Say what a tier actually buys you, from its own numbers. */
function tierBlurb(tier) {
  const gains = [];
  if ((tier.capacity_mult ?? 1) !== 1) gains.push(`holds ${mult(tier.capacity_mult)} as much`);
  if ((tier.keeps_mult ?? 1) !== 1) gains.push(`keeps things ${mult(tier.keeps_mult)} as long`);
  if ((tier.speed_mult ?? 1) !== 1) gains.push(`works ${mult(tier.speed_mult)} as fast`);
  // Said in words rather than as a number, because it is the only rung on any
  // ladder that changes who has to be standing there — "0.45×" is a ratio
  // nobody can price, and "serves its own queue" is the whole reason to buy it.
  if ((tier.unattended ?? 0) > 0) gains.push('serves its own queue with nobody on it');
  return gains.length ? `${gains.join(', ')}.` : 'Same job, better looking.';
}

const mult = (n) => `${Number(n) % 1 === 0 ? n : Number(n).toFixed(1)}×`;

/** What "empty it" would tip out, and how to describe it. */
function contentsOf(ui, f, live) {
  if (holdsGoods(f.kind)) {
    // Across every board, and named board by board — "empty it" tips the whole
    // unit out, one crate per kind, so the count has to be the whole unit too.
    const stacks = (live?.stacks ?? []).filter((k) => k.qty > 0);
    const n = stacks.reduce((a, k) => a + k.qty, 0);
    return {
      n,
      // …and what happens NEXT, which is the half worth saying: without the mark
      // the crates this makes are lifted by the first stocker past and the unit
      // is back the way it was, so a press that meant "I'll refill this myself"
      // reads as a button that does not work. A board you kept it for is the
      // exception, and it is the one already named a tab above.
      blurb: n
        ? `${stacks.map((k) => `${k.qty}× ${ui.itemName(k.item_id)}`).join(', ')} into crates beside it. `
          + `The shop stops restocking ${live?.assigned?.length ? 'whatever it is not kept for' : 'them'}.`
        : '',
    };
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
