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

import { FIXTURES, FIXTURE_REFUND, STOCK_KINDS, anchorTile, holdsGoods, shelfKind, sameFixture, sorterRoute, mergeRoute, conveyorFeeders, mergeStraight, CONVEYOR_KINDS } from '../shared/build.js';
import { pieceFor } from '../shared/pieces.js';
import { homeKind } from '../shared/tags.js';
import { LOT_KINDS, lotStacks, lotHas, lotLabel } from '../shared/lot.js';
import { tierProgress, variantsOf } from '../shared/model.js';
import { ICONS } from './icons.js';
import { money, signed } from './money.js';
import { artForModel, artForVariant } from './thumb.js';
// What is on a van, shared with the supplier so the two cannot disagree about
// how many eggs are coming — see client/orders.js.
import { comingByItem, comingWhy } from './orders.js';
import { deptOf, deptsIn, deptStrip, inDept, wireDepts } from './aisles.js';

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

/**
 * Which fixtures a row's press is about — this one, or everything picked.
 *
 * One spelling on this side, matching the one `targets` is on the server's, and
 * for the same reason: five rows each deciding for themselves whether the
 * selection counts is five places to forget it. Every row that can act on a
 * whole selection sends `ids`; a selection of one sends a list of one, which is
 * the old message exactly.
 *
 * Falls back to the fixture the menu is named after. `pickedIds` is empty while
 * your hands are full — `selectedFixture` refuses then, because every verb it
 * feeds is about something standing in the shop — and a row that sent no
 * targets at all would be a press that silently does nothing.
 */
function aimAt(ui, f) {
  const ids = ui.pickedIds();
  return ids.length ? ids : [f.id];
}

/**
 * Do they ALL say the same thing about this?
 *
 * What a tick means for a selection: `picked` is true only when every unit
 * agrees, because a row that lit up for four of six would be the menu making a
 * claim about two units that are off screen behind you. The press that follows
 * sends what it wants explicitly (`on: !allSay(...)`) rather than "flip it" —
 * the same argument the `assign` message already carries `on` for, one step
 * further out: six flips is six different answers.
 */
const allSay = (lives, fn) => lives.length > 0 && lives.every((l) => fn(l));

/**
 * What the verbs that are still one-at-a-time say to a selection.
 *
 * One string, because it is said by this menu's foot and by the two keys that
 * stand in for two of those buttons (R and M) — and a key that refused for a
 * different reason than the button it duplicates is two rules to learn.
 */
export const ONE_AT_A_TIME = 'One at a time — shift-click the others back off first.';

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
  // `keepPicked`: opening a menu is not a decision about the SELECTION. The
  // decision was taken by the press that got here (`selectFixture` clears,
  // `togglePicked` adds), and this is also the call every redraw makes — a
  // re-flow, a tick, a row pressed — so clearing here would drop the other five
  // units the moment you used the menu on them.
  ui.setFixtureRef(f, { keepPicked: true });
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

  // Everything picked, `f` first. One is the ordinary case and the whole menu
  // below is written for it; several is the shift-clicked selection, and what
  // changes is narrow on purpose — the rows that are a *standing decision* about
  // a unit act on all of them, and everything else is still about the one the
  // menu is named after. See `bulkRows` for the rule.
  const many = ui.pickedFixtures();
  const bulk = many.length > 1;
  // What every one of them agrees about, since a tick that is true of four of
  // six is a menu lying about two units you cannot see from here.
  const lives = many.map((g) => liveFixture(ui, g));
  // ...and what the verbs that act on all of them actually walk. Over `many`
  // when there is one and over this unit alone when there is not:
  // `pickedFixtures` answers with nothing while your hands are full (a selection
  // is a thing R and M act on, and neither can act on what you are carrying),
  // and the menu is still open on a fixture that can perfectly well be upgraded
  // or sold back.
  const upFor = many.length ? many : [f];
  const upLives = many.length ? lives : [live];

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
  //
  // `tab` is the SHORT one — one word, on the strip. It cannot be `label`,
  // because a label here is a sentence about the fixture ("Keep it for", "Sow
  // it with", "More of these") and a tab is a thing you aim at: three words
  // ellipsised into 80px is a strip of half-words. It cannot be `find` either,
  // which is a plural noun for the search placeholder and reads as a category
  // of goods rather than a part of this menu ("shapes", "deals"). So it is its
  // own field, and it is the only one of the four that is allowed to be a
  // fragment.
  const groups = [];
  const group = (label, icon, rows, find, tab) => {
    if (rows?.length) groups.push({ label, icon, rows, find, tab });
  };

  // What to plant belongs to the plot you're stood at, not to a menu of its own
  // three icons away. It sets the same one seed the wheel does — the choice is
  // the player's, not the plot's — but this is where you are when you want it,
  // and at an empty bed it outranks moving or selling the thing.
  // A ripe bed offers no seeds: picking one there would throw the harvest away.
  // Sowing is not a standing decision, it is one bed being planted now, and it
  // spends a seed per bed — so it is not on offer to a selection. The same test
  // (`!bulk`) covers the recipe list below and for the same reason: what a
  // machine is set to make is per machine, and six machines set to one recipe is
  // a kitchen making six of the same thing out of one hopper's worth of stock.
  if (f.kind === 'plot' && !live?.ready && !bulk) {
    group(live?.crop_id ? 'Sow something else' : 'Sow it with', ICONS.seeds,
      seedRows(ui, f, live), 'seeds', 'Seed');
  }

  // Anything that holds stock gets the same treatment a bed gets: what goes in
  // it is decided at the thing itself. A shelf's answer is a standing one
  // rather than a single sowing, so it also gets to say how eagerly the shop
  // keeps that promise — which is the difference between "we sell milk here"
  // and "we are never out of milk".
  // A mixed selection is offered what the WHOLE of it can do, which for stock is
  // that every unit in it keeps the same kind of goods: a freezer and a warmer
  // picked together share no item that could go on both, and `assignShelf`
  // refuses the mismatch one unit at a time — so the list would be forty rows
  // that half-work. `shelfKind` is the same normalisation the sim uses, which is
  // what stops this being a fourth hand-written list of kinds.
  const oneStockKind = many.every((g) => holdsGoods(g.kind) && shelfKind(g.kind) === shelfKind(kind));
  if (holdsGoods(kind) && oneStockKind) {
    // Built once and shown twice. The shortlist is a *selection* of these rows,
    // not a second list about the same items — see `quickRows`.
    const items = stockRows(ui, f, live, { many, lives });
    // In front of the full list, because it is the answer for almost every
    // shelf almost every time: the whole catalogue is what you open when the
    // shortlist did not have it. No `find`, and none needed — `QUICK_ROWS`
    // keeps it under the line the search box appears at, on purpose.
    group('Quick pick', ICONS.quick, quickRows(ui, items), null, 'Quick');
    group(live?.assigned?.length ? 'Kept for' : 'Keep it for', ICONS.crate, items, 'items', 'Stock');
  }

  // What an appliance is set to make. The same argument the shelf above makes:
  // what a thing is FOR is decided at the thing, and for a machine that knows
  // four recipes and runs one, it is the only decision there is.
  if (kind === 'station' && !bulk) {
    group('Set it to make', ICONS.station, recipeRows(ui, f, live), 'recipes', 'Recipe');
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
  group('Settings', ICONS.settings, settingRows(ui, f, live, { many, lives }), null, 'Settings');

  // A shape is free and keeps whatever is on it, so it is a browse rather than a
  // decision — which is exactly what belongs in the scrolling half. One shape is
  // not a choice, so a kind nobody has drawn a second design for gets no tab.
  //
  // ...and to a selection it is offered only when every unit in it is the same
  // DESIGN, which is the same test the held Shift lights up on (`designOf`).
  // Two designs share a kind and not a shape list, so a mixed pair would be
  // offering "Wall unit" to a shelf that has no such shape and refusing half the
  // press — where the point of the row is that it is one decision.
  const oneDesign = many.every((g) => ui.designOf(g) === ui.designOf(f));
  const styles = oneDesign ? styleRows(ui, f, { many }) : [];
  if (styles.length > 1) group('Shape', ICONS.fixtures, styles, 'shapes', 'Shape');

  // A deal is bought once and applies to everything you build afterwards, so it
  // is not a thing a selection changes the meaning of — and a menu about six
  // shelves is not where anybody is shopping. It comes back with the selection.
  if (!bulk) group('More of these', ICONS.build, moreOfTheseRows(ui, f), 'deals', 'Buy');

  // ---- the head: what it is ------------------------------------------------
  //
  // ...or what THEY are, when several are picked. A shelf's head is its boards —
  // what is on each, at what price, with a button to take an armful — and every
  // one of those is about one unit standing in one place. Printing the first
  // one's over a selection of six would be the menu answering a question about
  // six things with a fact about one of them, and the fact people would act on.
  const parts = [`<div class="pnl-head">${bulk
    ? selectionDetail(ui, many)
    : fixtureDetail(ui, f, live)}</div>`];

  // ---- the middle: the long half, tabbed once there is more than one --------
  //
  // Tabs by the same rule sections use (`tabGroups` in ui.js): two or more
  // groups earns them, one does not. Forcing tabs on a till — which has only
  // ever had shapes to show — would hide three rows behind a click each.
  const rows = [];
  const at = Math.min(ui._fxTab ?? 0, Math.max(0, groups.length - 1));
  // Tabs sit OUTSIDE the scroller — they choose what it holds, so scrolling
  // them away leaves you in a list with no way back to the one you wanted.
  //
  // The slot is RESERVED here and filled at the end, because what a tab has to
  // say depends on something settled below it: whether a search is running at
  // all is not known until the open tab has been measured (`filterable`, and
  // the `clearFilter` under it), and a badge drawn off a query that is about to
  // be cleared is a number on screen for a box that is not.
  const tabSlot = parts.length;
  if (groups.length > 1) parts.push('');
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
  // ...and now the tabs can say where the answer is.
  //
  // The search box sits ABOVE the tabs, which reads as a question about the
  // menu, and it only ever filtered the open one — so typing "milk" at a
  // freezer's settings answered "Nothing matches that", which was a lie: milk
  // was one tab over, and nothing on screen said so. An empty pane had two
  // explanations (the menu hasn't got it / you are stood in the wrong pane) and
  // gave you neither.
  //
  // A COUNT rather than a merged result list, and that is the whole design
  // decision. `wireRows` binds by index into one array — the comment under
  // `mid` says why the filtered list is the one numbered — so searching across
  // every tab is a re-numbering of the pane, and the way that fails is a click
  // firing the wrong row rather than a list that looks odd. A badge changes
  // nothing about what the list IS; it just stops the empty pane being the only
  // thing you are told.
  //
  // Counted on the group's own rows and deliberately NOT through `inDept`: the
  // department strip narrows the pane in front of you, and the badge is about
  // the panes that are not. Same `tcount` the sections already draw, so a tab
  // wearing a number means one thing everywhere in the game.
  if (groups.length > 1) {
    parts[tabSlot] = `<div class="tabs">${groups.map((g, n) => {
      const hits = ui.query ? ui.applyFilter(g.rows ?? []).length : null;
      // NAMED, the way a section's tabs are. An icon row is a shape you learn
      // and a word is a thing you read, and this strip has five pictograms on
      // it that nobody has met before — the `sep` under the tabs exists purely
      // because "on first open nobody knows which pictogram is the seed one",
      // which is a caption apologising for the strip above it. `title` keeps
      // the full sentence, since `tab` is a fragment by design.
      return `<button class="tab named${n === at ? ' on' : ''}${hits === 0 ? ' none' : ''}"
        data-fxtab="${n}" title="${esc(g.label)}${hits != null ? ` — ${hits}` : ''}"
        aria-label="${esc(g.label)}">${g.icon}<span class="tlabel">${
  esc(g.tab ?? g.label)}</span>${
  hits != null ? `<i class="tcount">${hits}</i>` : ''}</button>`;
    }).join('')}</div>`;
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

  // Move and Rotate are one at a time, and with several picked they say so
  // rather than disappearing.
  //
  // Which of the two is not a style question. A hole cannot answer "where is the
  // Move button" — the same argument the disabled order button on a board row
  // makes — and this row is the most familiar thing on the menu, so a selection
  // that quietly shortened it would read as the menu having broken. And each of
  // the two is genuinely a different sentence about six things than about one:
  // Move fills your hands with one fixture, and Rotate turns each into its own
  // corner. They are one press away — shift-click the one you want, or Escape.
  //
  // The ladder and Remove are not among them, and the line between the two
  // halves is worth saying: a verb belongs here when six of it would be six
  // DIFFERENT things, and belongs to the selection when six of it is one thing
  // said once. "Get rid of that aisle" and "make my freezers better" are both
  // the second — they are the presses a selection is *for*. See their own
  // squares below.
  const alone = bulk ? ONE_AT_A_TIME : null;
  const only = alone ? { off: true } : {};

  // The keys are on the buttons for the reason every other key in the game is on
  // its button: a shortcut nothing names is a shortcut for whoever wrote it. Both
  // of these work on whatever this menu is open on, wherever the pointer is —
  // see `rotateSelected` and `moveSelected`.
  foot.push(actIcon('move', ICONS.move, 'Move it',
    alone ?? 'Picks it up with everything on it. Nothing shifts until you set it down.',
    'Move', { key: 'M', ...only }));

  if (FIXTURES[kind]?.rotates) {
    // Which side a thing faces means something different for each of them, and
    // it is the reason to turn it at all — so the tooltip says the actual
    // reason. It costs nothing to be specific in a tooltip.
    const why = {
      checkout: 'Quarter turn. Sets where you serve and which way the queue runs.',
      station: 'Quarter turn. Sets which side you load it from.',
      lift: 'Quarter turn. Sets which side it carries on to at the other end.',
    }[kind] ?? 'Quarter turn. Sets which aisle shoppers browse it from.';
    foot.push(actIcon('rotate', ICONS.rotate, 'Rotate', alone ?? why, 'Rotate', { key: 'R', ...only }));
  }

  // Upgrading sits above the destructive half of the list: it is the thing you
  // are most likely to have opened a shelf you already like in order to do.
  //
  // The pair is all-or-nothing, and that is `.fx-verb.off`'s rule rather than a
  // preference: these squares are `flex: 1`, so a row that gains a sixth does
  // not append one — it narrows and shifts all five, under a pointer that has
  // not moved. Pressing Upgrade therefore slid Downgrade under your finger, and
  // the second press UNDID the first, for real money, in both directions (the
  // top rung takes Upgrade away again). So a fixture with a ladder always shows
  // both rungs and greys whichever end it is standing on. The dead square this
  // was avoiding is real and is the cheaper of the two: it appears only on
  // something that can be climbed at all, next to the verb it is the other half
  // of, and it never moves.
  //
  // Both rungs act on the WHOLE selection, and each unit climbs its own ladder:
  // a rung is priced per piece, so six units standing at three different tiers
  // is six different prices and one press. That is the whole argument for it
  // being bulk — "make my freezers better" is one decision about the shop, and
  // the version where it is six is six opens of six menus. Whichever of them is
  // already at the end of its ladder is simply not in the batch, exactly as an
  // unemptied shelf is not in a bulk Remove.
  const next = nextTier(ui, f);
  const back = prevTier(ui, f);
  const ups = upFor.map((g) => nextTier(ui, g)).filter(Boolean);
  const downs = upFor.map((g) => prevTier(ui, g)).filter(Boolean);
  const upCost = ups.reduce((n, t) => n + (t.cost ?? 0), 0);
  const downBack = downs.reduce((n, t) => n + (t.refund ?? 0), 0);
  if (ups.length || downs.length) {
    // Against the CHEAPEST rung rather than the total, which is the same call
    // `bulkFixtures` makes about a refusal: the server upgrades what the cash
    // covers and reports the rest, so a button greyed on the total would be
    // dead over a press that would have worked. The tooltip says the total is
    // out of reach; the square still does what it can.
    const each = ups.map((t) => t.cost ?? 0);
    const afford = ups.length && (ui.state?.cash ?? 0) >= Math.min(...each);
    const short = ups.length && (ui.state?.cash ?? 0) < upCost;
    // The tier name is authored content and can be any length, so it goes in the
    // wrapping description rather than the one-line title — `Upgrade to With a
    // register` was both clipped and barely a sentence. The title is the verb,
    // which is fixed and short; the row below it says what you actually get.
    const blurb = next ? `${next.name} — ${tierBlurb(next)}` : '';
    const stuckUp = upFor.length - ups.length;
    foot.push(actIcon('upgrade', ICONS.tierup, bulk ? `Upgrade ${ups.length}` : 'Upgrade',
      bulk
        ? (ups.length
          ? `Each goes up one rung, at its own price.${
            stuckUp ? ` ${stuckUp} are already the best there is.` : ''}${
            short ? ' You cannot afford all of them — it will do what it can.' : ''}`
          : 'All of them are already the best there is.')
        : (next
          ? (afford ? blurb : `${blurb} You cannot afford it yet.`)
          : 'Already the best there is.'), 'Upgrade',
      // A tier that is purely cosmetic still costs nothing, and `$0` in the
      // price column reads as a broken number rather than as good news.
      {
        off: !afford,
        right: ups.length ? (upCost > 0 ? money(upCost) : 'free') : '',
      }));

    // Straight under Upgrade, because it is the same ladder and the pair reads
    // as one control.
    const stuckDown = upFor.length - downs.length;
    foot.push(actIcon('downgrade', ICONS.tierdown, bulk ? `Downgrade ${downs.length}` : 'Downgrade',
      bulk
        ? (downs.length
          ? `Each drops one rung and keeps its stock.${
            stuckDown ? ` ${stuckDown} are already as plain as they get.` : ''}`
          : 'All of them are already on the first rung.')
        : (back
          ? `Back to ${back.name} — ${tierBlurb(back)} Half of that rung back, and it keeps its stock.`
          : 'Already on the first rung.'),
      'Downgrade', { off: !downs.length, right: downBack > 0 ? signed(downBack) : '' }));
  }

  // ...and the same rule as the ladder pair above, one square along, where what
  // slides under your finger is Remove. Unlabelling is the last press in a
  // sequence people make in one go — Empty, then Unlabel — and it used to take
  // its own square away with it, sliding a single-press Remove into the spot the
  // finger was already coming back to. So a unit that can ever hold anything
  // always keeps the square and greys it when there is nothing left in it; a
  // kind that can never hold anything still shows none.
  const holds = contentsOf(ui, f, live);
  const emptiable = holdsGoods(kind) || kind === 'station' || kind === 'plot' || kind === 'pen';
  if (holds.n > 0) {
    foot.push(actIcon('empty', ICONS.empty, 'Empty it', alone ?? holds.blurb, 'Empty',
      { right: `${holds.n}`, ...only }));
  } else if (holdsGoods(kind) && live?.stacks?.length) {
    // The labels are what was last on each board; what it is *kept* for is a tab
    // above and survives this. This one keeps its sub-line, because "take the
    // labels off" does not say WHICH — and on a shelf that is also kept for
    // something, not saying so is the menu looking like it will undo both.
    const labels = live.stacks.map((k) => ui.itemName(k.item_id)).join(', ');
    foot.push(actIcon('empty', ICONS.label, 'Take the labels off',
      alone ?? (live.assigned?.length
        ? `Last held ${labels}. It stays kept for ${live.assigned.map((id) => ui.itemName(id)).join(', ')}.`
        : `Still labelled ${labels}. Clear them and anything can go on.`),
      // Not "Label" — that reads as a verb for putting one ON, which is the
      // opposite of what this does and is a tab away.
      'Unlabel', { ...only }));
  } else if (emptiable) {
    foot.push(actIcon('empty', ICONS.empty, 'Empty it',
      alone ?? (kind === 'plot' ? 'Nothing growing in it.'
        : kind === 'pen' ? 'Nothing ready in it yet.' : 'Nothing in it.'),
      'Empty', { off: true }));
  }

  // A greyed square says nothing about why, and this is the one verb people
  // press and get refused — so the reason IS the tooltip when there is one.
  //
  // ...and it acts on the WHOLE selection, like the ladder above it. Clearing
  // an aisle was six opens and six presses, which is the shift-click doing half
  // a job — see the note above `alone` for the line between these and the two
  // verbs that stay single.
  //
  // What it needs that a single press does not is an honest count, because
  // `bulkFixtures` refuses only a batch that changed NOTHING: a selection with
  // one full shelf in it tears the rest out and says so in the feed. So the
  // square is dead only when every one of them is blocked, and the price column
  // adds up the ones that can actually go.
  //
  // A till is counted against the SELECTION rather than per fixture, the same
  // way the server counts it: three tills picked in a shop with three is two
  // removals and a refusal, and a square offering three refunds would be
  // over-promising by half a till — the green-ghost rule, wearing a price.
  let tillsSpare = (ui.state?.queues?.length ?? 0) - 1;
  const goes = upFor.filter((g, i) => {
    if (contentsOf(ui, g, upLives[i]).n > 0) return false;
    if (g.kind === 'checkout') return tillsSpare-- > 0;
    return true;
  });
  const paidBack = goes.reduce((n, g) => n + refundFor(ui, g), 0);
  const stuck = upFor.length - goes.length;
  foot.push(actIcon('remove', ICONS.remove,
    bulk ? (kind === 'station' ? `Sell ${goes.length} back` : `Remove ${goes.length}`)
      : (kind === 'station' ? 'Sell it back' : 'Remove it'),
    bulk
      ? (goes.length
        ? `Half of what they cost back.${stuck ? ` ${stuck} of them cannot go yet.` : ''}`
        : 'None of these can go yet.')
      : blocked ?? 'Half of what it cost back.',
    kind === 'station' ? 'Sell' : 'Remove',
    {
      danger: true,
      off: !goes.length,
      right: goes.length ? signed(bulk ? paidBack : refund) : '',
      // On the button for the same reason M and R are on theirs. The cap sits
      // top-left and the refund top-right, so this is the one square in the row
      // wearing both and they do not meet.
      key: 'Del',
    }));

  parts.push(`<div class="pnl-foot"><div class="fx-verbs">${foot.join('')}</div></div>`);

  // Which unit, and which tab of it. Reserving an item or picking a shape
  // redraws the whole menu and must keep your place in a list that can run to
  // forty items; changing tab or aiming at another shelf must not.
  //
  // ...and how many, because the title is the one place that says a press here
  // is about six things rather than one. The count is in the repaint key with
  // everything else in it: picking another unit changes what the rows say, and a
  // menu keyed only on the fixture would not redraw for it.
  ui.showPanel(`${FIXTURE_ICON[kind] ?? ICONS.crate} ${bulk
    ? `${many.length} picked` : ui.fixtureName(f)}`, parts.join(''),
  `fixture:${f.id}:${many.length}:${at}:${ui.query}:${ui._fxDept ?? ''}`);
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
  // The same one row that scrolls the supplier's is — see `wireDepts`. Every
  // press above redraws this menu whole, so the strip that comes back is a new
  // element and knows nothing about where the old one was scrolled to.
  wireDepts(ui.el.panelBody);
  ui.el.panelBody.querySelectorAll('[data-fxtab]').forEach((el) => {
    // Redrawn rather than shown/hidden, because the rows are live: a tab built
    // once would still be offering to sow a bed that has since been harvested.
    //
    // The query goes with the tab, EXCEPT onto a tab wearing a count. Clearing
    // it is right for the reason it always was — carrying "carrot" onto Shape
    // leaves you looking at an empty pane wondering which of the two narrowings
    // did it — and a badge is precisely the thing that answers that in advance:
    // a tab that says 1 cannot be the empty pane. Dropping the query there
    // would make the badge half a feature, since the press that acts on it
    // would land you in the full list with the word to type again.
    el.onclick = () => {
      const n = Number(el.dataset.fxtab);
      ui._fxTab = n;
      if (!(ui.query && ui.applyFilter(groups[n]?.rows ?? []).length)) ui.clearFilter();
      showFixture(ui, f);
    };
  });
}

/**
 * The heads on an appliance, resolved the same way the server resolves them:
 * whatever the snapshot says, and failing that — on the FIRST head only — the
 * first recipe the machine knows, because a machine nobody has chosen for is
 * running its first recipe while a second head nobody has pointed anywhere is
 * idle.
 *
 * Two spellings of "which recipe is this making" is a menu that names one thing
 * while the bays over the machine draw another.
 */
function stationLines(ui, f, live) {
  const mine = (ui.catalog.recipes ?? []).filter((r) => r.station === f.station);
  const slots = live?.lines ?? [{ recipe: live?.recipe ?? null }];
  return slots.map((slot, i) => ({
    ...slot,
    recipe: mine.find((r) => r.id === slot.recipe) ?? (i === 0 ? mine[0] : null) ?? null,
  }));
}

/**
 * What this appliance could be making, as pickable rows.
 *
 * A machine knows several recipes and runs one per HEAD, so this is a capped
 * list of ticks — the shape a shelf's reservations take, with a ceiling. It was
 * a picker for as long as every machine had one head, and on a machine that
 * still has one it behaves identically: pressing a row is the whole decision,
 * the hopper resizes to it, the shop starts buying for it, and what the machine
 * will and won't take in your hands changes with it.
 *
 * Above one head, pressing a row TOGGLES it, and the whole set goes in one
 * message — `bulkFixtures`' argument on the other axis, since two heads changed
 * by two presses is two lines in the feed for one decision. A row that would be
 * the `lines + 1`th is dead with the ceiling said on it, rather than silently
 * swapping something out: a tick list that quietly drops one to take another is
 * a list that lies about what a press does.
 *
 * Each row prints its own ingredients, because the choice IS the ingredients —
 * "Fresh Salsa" over "Berry Smoothie" is a decision about whether you have
 * tomatoes. It costs a line and saves opening something else to find out.
 */
function recipeRows(ui, f, live) {
  const heads = stationLines(ui, f, live);
  const one = heads.length === 1;
  const on = heads.map((h) => h.recipe?.id).filter(Boolean);
  const full = on.length >= heads.length;
  const send = (ids) => ui.net.send('station-recipe', { stationId: f.id, recipeIds: ids });
  return (ui.catalog.recipes ?? [])
    .filter((r) => r.station === f.station)
    .map((r) => {
      const picked = on.includes(r.id);
      // Where the ceiling bites. On a one-headed machine there is no ceiling to
      // hit — pressing another row REPLACES, which is the picker this has always
      // been — and the row it is already on is the dead one.
      const blocked = one ? picked : (picked ? on.length <= 1 : full);
      return {
        icon: ICONS.station,
        name: r.name,
        // Per batch, not per hopper. It is the number that decides whether the
        // thing can run at all, and the hopper's ceiling is on the head above.
        sub: (!one && !picked && full)
          ? `it makes ${heads.length} at a time — untick one first`
          : `${r.inputs.map((i) => `${i.qty}× ${ui.itemName(i.item_id)}`).join(' + ')} → ${r.output_qty ?? 1}× ${ui.itemName(r.output_id)}`,
        facets: r.inputs.map((i) => ui.itemName(i.item_id)),
        right: `${(r.minutes ?? 0)}m`,
        picked,
        // Dead rather than absent, the way the shape picker treats the shape you
        // are already wearing: a row that vanished when you pressed it would
        // leave the list a different length every time you looked.
        run: blocked ? null : () => {
          if (one) return send([r.id]);
          return send(picked ? on.filter((id) => id !== r.id) : [...on, r.id]);
        },
      };
    });
}

/**
 * The shapes this kind comes in, as pickable rows.
 *
 * Free, and it keeps the stock — restyling goes through the same reposition
 * path moving and turning do. So this is a decision you can take back, which is
 * the whole reason it can sit in the menu next to Remove without a warning.
 */
function styleRows(ui, f, { many = [f] } = {}) {
  // The shape they are ALL wearing, or none — so a selection standing in three
  // different shapes has no row marked, and every row is live. Which is right:
  // with nothing ticked, every one of them is a change, and that is what the
  // press does.
  const here = many.every((g) => (g.variant ?? '') === (f.variant ?? '')) ? f.variant ?? '' : null;
  const count = many.length;
  return variantsOf(pieceFor(ui.catalog.fixtures ?? [], f)).map((v) => ({
    // Each shape wearing its own shape, the same picture the palette's shape
    // card draws — "Wall corner" and "Wall corner (other way)" are one word in
    // two spellings otherwise, and a column of identical glyphs is the list
    // saying nothing about the only thing being chosen here. `icon` stays as
    // the fallback for a shape nobody has drawn a model for.
    art: artForVariant(v),
    icon: ICONS.fixtures,
    name: v.name,
    sub: v.id === here
      ? (count > 1 ? `what all ${count} of them are` : 'what this one is')
      : (count > 1
        ? `free — all ${count} of them, and each keeps whatever is on it`
        : 'free — it keeps whatever is on it'),
    picked: v.id === here,
    run: v.id === here ? null : () => ui.withBuildMode(() => {
      ui.net.send('build-style', { ids: aimAt(ui, f), variant: v.id });
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
function stockRows(ui, f, live, { many = [f], lives = [live] } = {}) {
  const home = shelfKind(f.kind);
  // How many units this list is deciding for. Everything else below is read off
  // the unit the menu is named after — how many boards it has, what is standing
  // on them, what a board of this would hold — and that stays true of a
  // selection of one design, which is the only selection this tab is offered to
  // (`oneStockKind`, and shapes do not change a ladder).
  const count = many.length;
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
  // fryer. Nothing said so: `restock` will not order a recipe output (it asks
  // `isCrafted` — the van will sell you one, your crew never buy one) and no
  // chef can produce it, so ticking it was the one choice in this panel with no
  // outcome at all in either direction.
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
      // Ticked when they ALL keep a board for it. The press then says which way
      // it means explicitly, so a selection where four of six already keep it
      // turns the other two on rather than flipping each — see `allSay`.
      const on = allSay(lives, (l) => (l?.assigned ?? []).includes(it.id));
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
          // …and a van is never due for something the CREW will not order. They
          // leave every recipe output to the kitchen (`restock` asks
          // `isCrafted`), so an empty board kept for salsa is waiting on an
          // appliance and a stocker unless you go and order some yourself —
          // which the delivery wording would have sent you to the supplier to
          // wait for instead.
          : (crafted.has(it.id) ? 'kept for this — the kitchen makes it, or order some'
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
        //
        // IT MOVED OFF THE LEAD, though, because the lead had a better job going
        // spare. `artForModel` is what the supplier's rows, the item menu and
        // this menu's own board list already draw — the goods themselves, off
        // the same catalog row the shelf builds its stock from — and a list of
        // forty identical crates is a list you read entirely by name in a game
        // whose whole point is that you can see what is on the shelf. So the
        // picture is the lead and the where-it-comes-from is a `mark`, which is
        // the slot for exactly this: a glyph that says something the caption
        // cannot spare a line for.
        //
        // Only on the CRAFTED ones. The crate is what most of the catalogue is,
        // and a mark on every row is a column of noise that says nothing by
        // being everywhere — the news is "your kitchen makes this and no van
        // will ever bring it", which is a minority and is the half that changes
        // what you would do. `icon` stays as the fallback for an item with no
        // model authored, or a row with no art is a row with no lead at all.
        art: it.model ? artForModel(it.model) : null,
        icon: crafted.has(it.id) ? ICONS.station : ICONS.crate,
        mark: crafted.has(it.id) ? {
          icon: ICONS.station,
          title: `${it.name} is made here — your crew will never order it.`,
        } : null,
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
          : () => ui.net.send('assign', { ids: aimAt(ui, f), itemId: it.id, on: !on }),
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
      sub: count > 1
        ? `Stop keeping all ${count} of them for anything. Your crew fill them with whatever sells.`
        : (kept.length > 1
          ? `Stop keeping it for those ${kept.length}. Your crew fill it with whatever sells.`
          : 'Stop keeping it for one thing. Your crew fill it with whatever sells.'),
      run: () => ui.net.send('assign', { ids: aimAt(ui, f), itemId: null }),
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
      ? 'Crew only. The shop orders extra to fill it, and the kitchen keeps its ingredients here.'
      : 'Shoppers browse it. Tap to make it crew-only storage.'),
    verb: 'build-boh',
  },
];

function modifierRows(ui, f, live, { many = [f], lives = [live] } = {}) {
  // Only the switches every picked unit carries. A switch offered to a
  // selection half of which has never heard of it is a press that half-lands,
  // and the half that did not is the half you cannot see.
  return MODIFIERS.filter((m) => many.every((g) => m.kinds.includes(g.kind))).map((m) => {
    const on = allSay(lives, m.on);
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
      run: () => ui.withBuildMode(() => ui.net.send(m.verb, { ids: aimAt(ui, f), on: !on })),
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
    sub: 'Dead boards go to the stockroom. Split ones get merged.',
  },
  {
    on: false,
    name: 'Leave it alone',
    sub: 'Only a sale takes stock off. It still gets refilled.',
  },
];

/**
 * What a sorter does with a box, which is one decision with four answers.
 *
 * Two of them read the shop. `smart` has the crew look at what is actually down
 * each line and send a box the way it can be put away — a filter that can never
 * fall behind your catalogue, because there is no filter. `alternate` is a plain
 * splitter with the thinking switched off, which is the other job people want
 * from a junction and is what one should honestly be with `auto` off.
 *
 * The other two are a PAIR about the same T, and they are the whole reason a
 * junction is worth turning: `straight` favours the line that carries on and
 * `branch` favours the leg it is aimed at, so R stopped being a press with
 * nothing on the far side of it. Both fall back to the ordinary chooser when the
 * leg they favour is full — a preference is not a queue you wait in for ever.
 */
const SORTS = [
  {
    route: 'smart',
    name: 'Wherever it fits',
    sub: 'Each box goes down a line that can shelve it.',
  },
  {
    route: 'straight',
    name: 'Straight ahead',
    sub: 'Unless that line is full.',
  },
  {
    route: 'branch',
    name: 'Down the branch',
    sub: 'The way it points. Turn with R.',
  },
  {
    route: 'alternate',
    name: 'Split evenly',
    sub: 'One box each way, whatever is in it.',
  },
];

function sortRows(ui, f, live, { lives = [live] } = {}) {
  return SORTS.map((s) => {
    const at = allSay(lives, (l) => sorterRoute(l) === s.route);
    return {
      icon: ICONS.stocker,
      name: s.name,
      sub: s.sub,
      picked: at,
      // Through `withBuildMode` like every other verb the server gates on the
      // mode. Without it the row is offered, pressed, and refused with "you have
      // to be in build mode" — while the menu it was pressed in opened perfectly
      // well outside the mode, so the game is asking for a permission it never
      // said it needed and the switch reads as simply not working.
      run: at ? null : () => ui.withBuildMode(
        () => ui.net.send('sorter-route', { ids: aimAt(ui, f), route: s.route }),
      ),
    };
  });
}

/**
 * Who goes first where two lines MEET, which is the plain belt's own junction.
 *
 * A sorter is bought to choose between ways OUT. This is the other T — two runs
 * feeding one — and it needs no piece at all, which is why it went this long
 * with no controls: there was nothing to open a menu on but a conveyor, and a
 * conveyor had nothing to say.
 *
 * Which line is "straight" is R. The cell points somewhere, so the run coming in
 * behind it is the one going straight through and the other is the leg — turn
 * the junction and you have swapped which is the main road, in the shop, where
 * you can see it, rather than in a list of compass points.
 */
const MERGES = [
  {
    merge: 'default',
    name: 'First come, first served',
    sub: 'Nearest box goes first.',
  },
  {
    merge: 'straight',
    name: 'Straight line first',
    sub: 'The branch waits for a gap.',
  },
  {
    merge: 'leg',
    name: 'Branch first',
    sub: 'The straight line waits for a gap.',
  },
  {
    merge: 'alternate',
    name: 'Take turns',
    sub: 'One from each. Empty lines get skipped.',
  },
];

/** Whether more than one line hands on to this cell — see `settingRows`. */
function isMerge(ui, f) {
  const L = ui.scene?.storeLayout;
  return !!L && conveyorFeeders(L, f).length > 1;
}

function mergeRows(ui, f, live, { lives = [live], many = [f] } = {}) {
  const L = ui.scene?.storeLayout;
  /**
   * ...and two of the four rows are only offered where there IS a main road.
   *
   * `straight` and `leg` are read off `rot`, which only names a direction of
   * travel on a belt and a tunnel mouth — a sorter's is the branch it favours, a
   * loader's is the shelf it stocks, a shaft's is the side it lands on. Offered
   * on those, the rows would tick and move no box: the server refuses them
   * (`mergeStraight` is null), so leaving them up would be a highlight
   * advertising a press the shop turns down, which is the green-ghost rule
   * wearing a menu. It also drops them on a Y-shaped join of plain belt, which
   * is the same claim about a shape rather than a piece.
   *
   * Take-turns needs no road at all, which is why the heading is worth having on
   * a sorter: that is the one everybody wants at the junction that backs up.
   */
  const road = !!L && many.every((g) => mergeStraight(L, g));
  return MERGES.filter((m) => road || (m.merge !== 'straight' && m.merge !== 'leg')).map((m) => {
    const at = allSay(lives, (l) => mergeRoute(l) === m.merge);
    return {
      icon: ICONS.stocker,
      name: m.name,
      sub: m.sub,
      picked: at,
      run: at ? null : () => ui.withBuildMode(
        () => ui.net.send('belt-merge', { ids: aimAt(ui, f), merge: m.merge }),
      ),
    };
  });
}

/**
 * Which half of its job a loader does.
 *
 * One machine that both lifts and pours is what makes a run work with nothing
 * configured, and it is why there is no separate loader and unloader. What it
 * cannot do is stand between a pad and a line: a loader with a yard on one side
 * and no shelving beside it lifts a box off that yard and puts it straight back,
 * because a pad outranks everything as somewhere to set a box down. The line it
 * was bought to feed never gets anything, and the machine looks like it is
 * working the whole time.
 */
const ARM_MODES = [
  { mode: 'both', name: 'Load and unload', sub: 'Puts boxes on the line and takes them off.' },
  { mode: 'load', name: 'Only load', sub: 'Puts boxes on. Never takes them off.' },
  { mode: 'unload', name: 'Only unload', sub: 'Takes boxes off. Never puts them on.' },
];

function armRows(ui, f, live, { lives = [live] } = {}) {
  return ARM_MODES.map((r) => {
    const at = allSay(lives, (l) => (l?.mode ?? 'both') === r.mode);
    return {
      icon: ICONS.stocker,
      name: r.name,
      sub: r.sub,
      picked: at,
      run: at ? null : () => ui.withBuildMode(
        () => ui.net.send('arm-mode', { ids: aimAt(ui, f), mode: r.mode }),
      ),
    };
  });
}

/**
 * What a packer is building.
 *
 * A CHECKBOX LIST capped at `LOT_KINDS`, and the cap is the whole design of this
 * panel rather than a validation on it. A crate holds three kinds, so a packer
 * told to build four can never be satisfied at all — it would stand there
 * holding goods nothing can reach for the rest of the save, with every light on
 * it saying it is working. The server refuses the fourth; this greys it, with
 * the reason said out loud, because a row that is refused on press and looks
 * available until then is the green-ghost bug wearing a menu.
 *
 * NONE TICKED IS THE ANSWER FOR ALMOST EVERY PACKER, which is why the heading
 * says so rather than the list opening empty and reading as unconfigured. With
 * no list it reads the run — `conveyorServes` plus `shelfAccepts`, the same
 * evidence a sorter routes on — so a packer you lay and never touch folds
 * whatever the aisle in front of it can take. Ticking is for the case the shop
 * cannot infer: a box you want assembled for one destination.
 *
 * The catalogue is unfiltered, deliberately, and it is the one place this differs
 * from a shelf's list. A shelf can only hold what its kind holds (`homeKind`),
 * so filtering there is telling the truth; a packer builds a BOX, and a box
 * holds anything — so a filter here would be an opinion about what you are
 * allowed to consolidate.
 */
function packerRows(ui, f, live, { lives = [live] } = {}) {
  const kept = live?.assigned ?? [];
  const full = kept.length >= LOT_KINDS;
  const holds = new Map((live?.holds ?? []).map((s) => [s.item_id, s.qty]));
  return (ui.catalog.items ?? []).map((it) => {
    const on = allSay(lives, (l) => (l?.assigned ?? []).includes(it.id));
    const got = holds.get(it.id) ?? 0;
    // Why it is greyed, said as a sentence rather than a disabled row with no
    // explanation — the shelf list's own rule.
    const why = !on && full ? `a crate holds ${LOT_KINDS} kinds` : '';
    return {
      icon: ICONS.crate,
      name: it.name,
      // What is already in the box, which is the one thing about this machine
      // you cannot see from across the shop: a box part built and a box about to
      // go out are the same box.
      sub: got ? `${got} in the box` : (on ? 'waiting for some' : ''),
      picked: on,
      why,
      run: why ? null : () => ui.withBuildMode(
        () => ui.net.send('packer-items', {
          ids: aimAt(ui, f),
          items: on ? kept.filter((id) => id !== it.id) : [...kept, it.id],
        }),
      ),
    };
  });
}

/**
 * Where a box nothing wants goes.
 *
 * Two rows rather than four compass points, because the address is already on
 * screen: the junction is aimed, and "the way it is pointing" is a thing you can
 * see and change with R. Naming a side in a list would be a second way of saying
 * the same thing, in words, about a shop you are looking at.
 *
 * Off is every sorter that has ever been built — with no reject line an unwanted
 * box splits across the junction exactly as it always did.
 */
function rejectRows(ui, f, live, { lives = [live] } = {}) {
  const rot = live?.rot ?? 0;
  /**
   * ...and WHICH SIDE that is, as a tile.
   *
   * The header above is right that the junction is aimed and you can see which
   * way — from directly overhead, on a camera that turns. "That way" and a
   * compass word are the same problem: the shop has no north on screen and the
   * player has tile numbers, which are drawn on the floor under the piece by
   * the Tile grid and are the one address in this game that does not rotate.
   *
   * It also makes the row honest about a state it could not previously show at
   * all. `reject` is an independent quarter turn — `setSorterReject` takes any
   * of the four — and this menu only ever offers the aimed one, so a press of R
   * afterwards leaves the two disagreeing and NEITHER row lit. With the tile
   * named, the row says where the press would send them rather than implying
   * that is where they go now.
   *
   * The tile comes off `f` and never off `live`: a sorter reaches the wire as
   * id, `auto`, `reject`, `riser` and `rot` — where it STANDS is not on it,
   * because every other reader already knows. Taken from `live` it read 0,0,
   * and `anchorTile` of that is a cheerful "goes to 1,0" on every junction in
   * the shop.
   *
   * ...and only for a selection of ONE. The row is a single row for however
   * many are picked, and six junctions have six different sides — so a named
   * tile there would be right about whichever the menu happened to open on and
   * wrong about the rest.
   */
  const one = (lives?.length ?? 1) === 1 ? (f ?? live) : null;
  const at = one && Number.isFinite(one.x) ? anchorTile(one.x, one.z, rot) : null;
  const where = at ? `goes to ${at.x},${at.z}` : 'goes that way';
  return [
    { set: null, name: 'Split the strays', sub: 'Shared across every line out.' },
    { set: rot, name: 'Send strays that way', sub: `Anything no line can take ${where}.` },
  ].map((r) => {
    const at = allSay(lives, (l) => (Number.isInteger(l?.reject) ? l.reject : null) === r.set);
    return {
      icon: ICONS.stocker,
      name: r.name,
      sub: r.sub,
      picked: at,
      run: at ? null : () => ui.withBuildMode(
        () => ui.net.send('sorter-reject', { ids: aimAt(ui, f), rot: r.set }),
      ),
    };
  });
}

/**
 * Whether a junction's fifth way out — the other storey — counts.
 *
 * Off on every junction ever built, and deliberately not derived the way its
 * four horizontal branches are. A belt beside a junction was laid AT the
 * junction; a duct over one is a route across the shop that happens to pass
 * over that square, and a return leg passes over everything.
 */
function riserRows(ui, f, live, { lives = [live] } = {}) {
  const up = (live?.deck ?? f.deck ?? 0) ? 'the floor below' : 'the run overhead';
  // A MOUTH SAYS IT DIFFERENTLY, because it is a different sentence about the
  // same switch. A junction gains a fifth way out and still weighs it against
  // the four it had; a tunnel has exactly one way out and this moves it — the
  // span surfaces onto the duct instead of onto the floor in front of it.
  const mouth = (f?.kind ?? live?.kind) === 'under';
  return (mouth ? [
    { on: false, name: 'Come up on the floor', sub: 'Hands on to the line it faces.' },
    { on: true, name: `Come up to ${up}`, sub: 'Needs a run up there, or it stays down.' },
  ] : [
    { on: false, name: 'Stay on this storey', sub: 'Only the lines beside it.' },
    { on: true, name: `Also use ${up}`, sub: 'One more way out. A line that wants the box still wins.' },
  ]).map((r) => {
    const at = allSay(lives, (l) => (l?.riser === true) === r.on);
    return {
      icon: ICONS.stocker,
      name: r.name,
      sub: r.sub,
      picked: at,
      run: at ? null : () => ui.withBuildMode(
        () => ui.net.send('sorter-riser', { ids: aimAt(ui, f), on: r.on }),
      ),
    };
  });
}

/**
 * Which way a shaft carries.
 *
 * Three rows and the first is every lift ever built: a shaft with one run on it
 * reads which way the goods already are, and telling it would be ceremony
 * around an answer it has. The other two exist for the shop where two runs
 * arrive on the same square, which is how the levels of one loop rejoin — there
 * is nothing to derive there, so the derivation takes the floor's arbitrarily
 * and half the time that is the wrong way round.
 *
 * The pass-through is deliberately NOT a fourth row. A shaft told Down hands to
 * a floor cell beside it, so a crate arriving along the floor carries straight
 * on into that cell while one arriving overhead descends into the same one — a
 * row for it would be a second name for a setting you already pressed.
 */
function liftRows(ui, f, live, { lives = [live] } = {}) {
  return [
    { set: null, name: 'Work it out', sub: 'Goes whichever way the boxes come from.' },
    { set: 'up', name: 'Always up', sub: 'To the ceiling run beside it.' },
    { set: 'down', name: 'Always down', sub: 'To the floor run beside it.' },
  ].map((r) => {
    const at = allSay(lives, (l) => (l?.way ?? null) === r.set);
    return {
      icon: ICONS.stocker,
      name: r.name,
      sub: r.sub,
      picked: at,
      run: at ? null : () => ui.withBuildMode(
        () => ui.net.send('lift-way', { ids: aimAt(ui, f), way: r.set }),
      ),
    };
  });
}

function handRows(ui, f, live, { lives = [live] } = {}) {
  return HANDS.map((h) => {
    // Ticked only when they all say it — see `allSay`. A selection that
    // disagrees has no row marked and every row live, which is exactly the
    // state it is in: whichever you press is a change to some of them.
    const at = allSay(lives, (l) => (l?.managed !== false) === h.on);
    return {
      icon: ICONS.stocker,
      name: h.name,
      sub: h.sub,
      picked: at,
      run: at ? null
        : () => ui.net.send('shelf-hands', { ids: aimAt(ui, f), on: h.on }),
    };
  });
}

function priorityRows(ui, f, live, { lives = [live] } = {}) {
  return PRIORITIES.map((p) => {
    const at = allSay(lives, (l) => (l?.priority ?? 0) === p.at);
    return {
      icon: ICONS.supplier,
      name: p.name,
      sub: p.sub,
      picked: at,
      run: at ? null
        : () => ui.net.send('restock-order', { ids: aimAt(ui, f), priority: p.at }),
    };
  });
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
function settingRows(ui, f, live, sel = {}) {
  const many = sel.many ?? [f];
  const rows = [];
  const under = (heading, list) => { if (list.length) rows.push({ sep: heading }, ...list); };
  // Every unit picked has to hold goods, not just the one the menu is named
  // after: a shelf and a till picked together share no refill order, and the
  // server would refuse the till on every press.
  if (many.every((g) => holdsGoods(g.kind))) {
    under('When it gets refilled', priorityRows(ui, f, live, sel));
    under('The shop hand', handRows(ui, f, live, sel));
  }
  if (many.every((g) => g.kind === 'arm')) {
    under('What it does', armRows(ui, f, live, sel));
  }
  /**
   * ...and a conveyor gets rows only where two lines actually MEET.
   *
   * Every other heading here is a fact about the KIND, and this one cannot be: a
   * shop lays belt by the hundred and all but a handful of those cells have one
   * way in. Offered on all of them it would be four rows of settings that decide
   * nothing on a straight run — which is worse than no control, because a row
   * that does nothing cannot be told from one that is broken.
   *
   * ...and it is a fact about the CELL rather than about the piece, which is why
   * this reads `CONVEYOR_KINDS` and not `belt`. It shipped as belt-only, on the
   * true observation that a merge needs no piece bought — and the square two
   * runs actually arrive at is usually the sorter, because a sorter is what you
   * build where lines meet. So the setting was missing from precisely the
   * junction that backs up, and nothing said so: a sorter's menu simply had one
   * heading fewer than the belt beside it.
   *
   * Asked of the layout rather than of the snapshot, because who feeds a cell is
   * derived (`conveyorFeeders`) and the derivation is the same one the sim uses.
   * A second opinion here would be the green-ghost rule wearing a menu: rows
   * offered for a merge the sim does not think is one.
   */
  if (many.every((g) => CONVEYOR_KINDS.includes(g.kind) && isMerge(ui, g))) {
    under('Where two lines meet', mergeRows(ui, f, live, sel));
  }
  if (many.every((g) => g.kind === 'sorter')) {
    under('Which way it sends things', sortRows(ui, f, live, sel));
    under('What nothing wants', rejectRows(ui, f, live, sel));
    under('The other storey', riserRows(ui, f, live, sel));
  }
  if (many.every((g) => g.kind === 'lift')) {
    under('Which way it carries', liftRows(ui, f, live, sel));
  }
  // What a packer is building. The heading says which of the two states it is
  // in, because "nothing ticked" is an ANSWER here rather than an empty form —
  // see `packerRows`.
  if (many.every((g) => g.kind === 'packer')) {
    under(live?.assigned?.length ? 'Building' : 'Build a box of',
      packerRows(ui, f, live, sel));
  }
  // A tunnel mouth wears the same switch, because a span coming up under an
  // aisle wants the duct over it as often as it wants the floor. Only the
  // downstream mouth can use it — the upstream one's way out is the span — and
  // the row is offered on both because which is which is a derivation
  // (`tunnelExit`) that changes the day somebody lays a third mouth in line.
  if (many.every((g) => g.kind === 'under')) {
    under('Where it comes up', riserRows(ui, f, live, sel));
  }
  under('Set up', modifierRows(ui, f, live, sel));
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
  // A live drag outranks a repaint, which the panel's own position drag already
  // says about `restorePos` — this is the same claim about the panel's
  // CONTENTS. A rebuild while a board is being dragged replaces the element
  // under the finger with a fresh one, so the drag ends holding a node that is
  // no longer in the document and the list snaps back to the snapshot's order.
  // One sale on the shelf you are tidying would do it.
  if (ui.boardDragging) return;
  // ...and the pointer merely being ON the menu is the same claim one step
  // weaker: a drag is a press you would lose, a hover is a press you are about
  // to make. Both are a rebuild under the hand using it. Flushed on
  // `pointerleave`, where this same function is called again — see the panel
  // listeners in ui.js for why a shelf menu redraws three times a second while
  // the shop is trading, and why none of it is about this fixture.
  //
  // ...unless you PRESSED one. `_panelPressed` is armed by any click inside the
  // panel and cleared by the repaint it was waiting for — see the listener in
  // ui.js. Without it a tick on a row is a message sent, a line in the feed and
  // a list that goes on drawing what it drew before, which reads as the press
  // being ignored.
  if (ui._overPanel && !ui._panelPressed) return;
  // ...BY TILE **AND KIND**, which is `liveRef` — never `fixtureAt`, and that
  // distinction is the whole of a bug that reads as a menu refusing to open.
  // `fixtureAt` answers "what is on this cell", and a cell can hold two things:
  // a hanging prop stamps no tile, so a tube light over a loader is two fixtures
  // at 15,22 and a `find` returns whichever `fixturesIn` lists first. This runs
  // every snapshot, so the menu you opened on the loader was re-read a frame
  // later as the lamp and redrawn as the lamp — twenty times a second, with the
  // press that got there working perfectly. What it looks like is the shop
  // insisting on the light.
  const f = ui.liveRef(ui.fixtureRef);
  if (!f) { ui.closePanel(); return; }
  if (fixtureSignature(ui, f, liveFixture(ui, f)) !== ui._fxMenuKey) {
    ui._panelPressed = false;
    showFixture(ui, f);
  }
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
  // ...and `sameFixture` rather than a fourth copy of "same tile, same kind",
  // because a duct over a belt is both — see `shared/build.js`.
  const found = fixtures.find((f) => sameFixture(f, at))
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
  if (f.kind === 'pen') return s.pens?.find((x) => x.id === f.id) ?? null;
  if (f.kind === 'station') return s.stations?.find((x) => x.id === f.id) ?? null;
  if (f.kind === 'checkout') return s.queues?.find((x) => x.id === f.id) ?? null;
  if (f.kind === 'sorter') return s.sorters?.find((x) => x.id === f.id) ?? null;
  if (f.kind === 'arm') return s.arms?.find((x) => x.id === f.id) ?? null;
  if (f.kind === 'lift') return s.lifts?.find((x) => x.id === f.id) ?? null;
  if (f.kind === 'under') return s.unders?.find((x) => x.id === f.id) ?? null;
  // A belt is the one kind with no record on the wire — a shop owns hundreds and
  // they carry nothing but their merge rule, so `merges` is sparse and a MISS is
  // the answer rather than an absence: `mergeRoute(null)` is `default`, which is
  // what every belt nobody has spoken for is. See the snapshot.
  if (f.kind === 'packer') return s.packers?.find((x) => x.id === f.id) ?? null;
  if (f.kind === 'belt') return s.merges?.find((x) => x.id === f.id) ?? null;
  return null;
}

/** Everything the open menu draws from, so it can redraw when any of it moves. */
export function fixtureSignature(ui, f, live) {
  return JSON.stringify([f.id, f.rot, f.tier, live, ui.state?.cash?.toFixed(0),
    // Which OTHER units are picked, and what each of them says. Every tick on
    // this menu is now a claim about the whole selection ("all six keep bread"),
    // so a signature that only watched this fixture's row would leave those
    // ticks describing a shop that has moved — including one somebody else in
    // the shop moved. Ids and the three switched fields only, never quantities,
    // for the reason the shelf fold below gives.
    ui.picked.map((r) => r.id).join(','),
    ui.pickedFixtures().slice(1).map((g) => {
      const l = liveFixture(ui, g);
      return `${g.id}:${(l?.assigned ?? []).join('+')}:${l?.priority ?? 0}`
        + `:${l?.managed === false ? 0 : 1}:${l?.boh === true ? 1 : 0}:${g.variant ?? ''}`;
    }).join(','),
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

/**
 * ...and the read-out at the top when SEVERAL are picked: what they are.
 *
 * A count per design rather than a list of units, because the list is on the
 * shop floor already — every one of them is wearing a teal frame, which is the
 * whole reason the marker is a set rather than one. What the panel can say that
 * the floor cannot is whether you have picked what you think you have: "6 ×
 * Basic Shelf" and "5 × Basic Shelf, 1 × Chest Freezer" are the same six frames
 * from across the room, and the second one is why half the rows below have gone.
 *
 * Named by `fixtureName`, which is the piece's own label — so two designs of
 * shelf count separately, which is exactly the distinction a bulk restyle turns
 * on.
 */
function selectionDetail(ui, many) {
  const line = (label, value) => `<div class="fx-line"><span>${label}</span><b>${value}</b></div>`;
  const byName = new Map();
  for (const g of many) {
    const name = ui.fixtureName(g);
    byName.set(name, (byName.get(name) ?? 0) + 1);
  }
  return `<div class="fx-detail">
    ${[...byName].map(([name, n]) => line(esc(name), `${n}`)).join('')}
    ${line('Picked', `${many.length}`)}
  </div>`;
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
    // Anything a recipe makes, which is now only a NOTE on a live button. The
    // van refused a recipe output for as long as appliances existed and this
    // row spent two revisions on the consequence — no button at all first, then
    // a disabled one saying why, because "a button that can only error is worse
    // than no button" is right about a button and wrong about a HOLE: three
    // boards kept for salsa, juice and skewers with no order control anywhere on
    // them read as ordering having gone missing from the menu, and an absence
    // cannot answer "where is the order button".
    //
    // The refusal is gone (`Game.buyStock`), so the third revision is the
    // simplest of the three: the button works, and being made here is a hint in
    // its title rather than a reason it is dead.
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
      // A made-here item is ordered like anything else — the van sells
      // everything again (`Game.buyStock`) — so the only thing left to say
      // about it here is that the kitchen is the cheaper way to fill this
      // board, which is a hint on a live button rather than a reason it is
      // dead.
      const madeHere = crafted.has(k.item_id);
      const orderWhy = bayRoom === 0 ? 'No room at the bay for another order.'
        : room <= 0 ? (inbound
          ? `${inbound} already on the way — ${comingWhy(due)}`
          : 'This board is full.')
          : madeHere
            ? `Order ${want}× ${name} — it lands at the bay on the next van. `
              + 'An appliance makes it cheaper, and your crew will never order it.'
            : `Order ${want}× ${name} — it lands at the bay on the next van.`;

      // The goods themselves, at the head of their own row. A unit holding three
      // things is three rows of words, and what is standing on the shelf you are
      // looking at is drawn — so the name was the only way to tell which board
      // was which, in a menu opened by pointing at the very thing it lists. Same
      // art the supplier's rows and the item menu wear (`artForModel`), off the
      // same catalog row the shelf builds its stock from, so all three agree by
      // construction. A `pending` board — kept for something that has not landed
      // — still draws it: what it is FOR is the whole content of that row.
      const art = item?.model ? artForModel(item.model) : null;
      // `data-board` is what makes the row draggable — see `wireBoardOrder`. It
      // names the ITEM rather than an index, because an index is a fact about
      // the list as it was drawn and the list is redrawn from the snapshot ten
      // times a second.
      return `<div class="fx-board${pending ? ' pending' : ''}" data-board="${esc(k.item_id)}">
        ${art ? `<span class="fx-bart">${art}</span>` : ''}
        <span class="nm">${esc(name)}</span>
        <b class="qty"${due ? ` title="${esc(comingWhy(due))}"` : ''}>${k.qty}${cap ? `<i>/${cap}</i>` : ''}${inbound ? `<i class="coming">+${inbound}</i>` : ''}</b>
        <span class="fx-price">
          <button ${pending ? 'disabled' : `data-price="-1" data-item="${esc(k.item_id)}"`}
            title="${esc(pending ? `Nothing on this board to price yet — ${name} takes its price when it lands.` : `Charge less for ${name}`)}" aria-label="Charge less">−</button>
          <b>${pending ? '—' : money(k.price ?? 0)}</b>
          <button ${pending ? 'disabled' : `data-price="1" data-item="${esc(k.item_id)}"`}
            title="${esc(pending ? `Nothing on this board to price yet — ${name} takes its price when it lands.` : `Charge more for ${name}`)}" aria-label="Charge more">+</button>
        </span>
        <button class="fx-take fx-order"
          ${want > 0
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
    // where every other thing you can do to a board already lived. `+6 at 2pm`
    // still gets said, on the board's own number, by the same `coming` fold: what
    // the line was for was telling "kept for juice, nothing ordered" apart from
    // "kept for juice, a van is due", and a board reading `0/12 +6` says that in
    // the column the question was asked in.
    /**
     * WHAT THE FOUR BUTTONS ARE, ONCE, ACROSS THE TOP.
     *
     * Every control on a board row is a glyph with its sentence in a `title`,
     * which is a label on a desktop and four unlabelled squares on a phone —
     * the same trap `actIcon` names and pays off with a word under the icon. A
     * row cannot afford that word four times over, so the words go where the
     * supplier already puts them: a head strip naming the columns, said once
     * for a list rather than once per line.
     *
     * Only with something under it. A head over an empty board list is four
     * labels naming nothing, and the row under it would be "Holding nothing".
     */
    const heads = boardRows ? `<div class="fx-heads">
      <span class="h-nm">Item</span>
      <span class="h-qty">Have</span>
      <span class="h-price">Price</span>
      <span class="h-btn">Order</span>
      <span class="h-btn">Take</span>
      <span class="h-btn">Clear</span>
    </div>` : '';

    return `<div class="fx-detail">
      ${line('Boards', `${stacks.length} of ${boards} in use`)}
      ${heads}
      ${boardRows ? `<div class="fx-boards">${boardRows}</div>` : line('Holding', '<i>nothing</i>')}
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

  if (f.kind === 'pen') {
    // How many head it is running, and it is here because this is the ONLY
    // place it can be read. A paddock divides the clock (`penFill`) and nothing
    // else — so a pen filling four times as fast and a pen filling once are the
    // same still frame, the same bar and the same shop. Counting the bodies out
    // in the field is the alternative, which is a thing you do rather than a
    // thing you see.
    //
    // The one-head line names the paddock rather than reporting a 1, because
    // every pen in every shop that has never painted one says this, and "1
    // animal" is a number that reads as working when what it means is that
    // there is a whole brush you have not found.
    // Which of the two is SHORT, because "out of grazing" and "out of shelter"
    // are the same number on the same line and opposite things to do about it —
    // and getting it wrong means painting half an acre at a pen that was never
    // going to keep another animal.
    const heads = live?.heads ?? 1;
    const most = live?.maxHeads ?? 1;
    const grazing = heads >= most
      ? `${heads} animals — all this shelter holds${most > 1 ? '. Upgrade it for more' : ''}`
      : `${heads} of ${most} — paint more paddock round it`;
    return `<div class="fx-detail">
      ${line('Grazing', heads > 1 || most > 1 ? grazing
    : 'one animal — paint a paddock round it to keep more')}
      ${line('Ready to collect', live?.qty
    ? `${live.qty}× ${ui.itemName(live.item_id)}` : '<i>nothing yet</i>')}
      ${line('Holds', `${live?.cap ?? 0}, then it stops filling`)}
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

    // The recipes it is set to — one block per HEAD, each ingredient counted
    // against what is actually in the hopper. It listed every recipe the machine
    // knew while the machine chose for itself, and that was two lists of numbers
    // where only one of them was ever going to happen. The others are a tab
    // below, as things to switch to rather than as things it might be doing.
    const heads = stationLines(ui, f, live);
    const held = (id) => live?.contents?.[id] ?? 0;

    // How much of an ingredient this machine takes, computed here off the same
    // recipes and the same `batches` the server used. The bar has to say the
    // ceiling: a hopper you can keep filling is only worth filling if the game
    // tells you how far, and "1 / 1" beside a full armful reads as a machine
    // that is refusing you rather than one that is loaded.
    //
    // Summed over the heads, because there is ONE bin: two heads that both want
    // milk want it once, and a per-head ceiling would have the same pile of milk
    // reading as full against one block and half empty against the other.
    const batches = live?.batches ?? 1;
    const wants = (id) => heads.reduce((n, h) => n + (h.recipe?.inputs ?? [])
      .filter((i) => i.item_id === id)
      .reduce((m, i) => Math.max(m, i.qty), 0), 0) * batches;

    const body = heads.filter((h) => h.recipe).map((h) => `
      <div class="fx-recipe">
        <div class="fx-recipe-h">
          <span>${esc(h.recipe.name)}</span>
          <b>makes ${h.recipe.output_qty ?? 1}×</b>
        </div>
        ${h.recipe.inputs.map((i) => `
          <div class="fx-ing${held(i.item_id) >= i.qty ? ' ok' : ''}">
            <span>${ui.itemName(i.item_id)}</span>
            <b>${held(i.item_id)} / ${wants(i.item_id)}</b>
          </div>`).join('')}
      </div>`).join('');

    // What is waiting to be picked up, which used only ever to be one batch and
    // so was never worth its own line. It is the reason to walk over now — and
    // on a machine with two trays it is what says which of them to walk over
    // for, so it names every one that has something on it.
    const trays = heads.filter((h) => h.output);
    const ready = trays.length
      ? trays.map((h) => `${h.output.qty}× ${ui.itemName(h.output.item_id)}`).join(', ')
      : '<i>nothing</i>';
    const running = heads.filter((h) => h.making);

    return `<div class="fx-detail">
      ${line('In the hopper', inside || '<i>empty</i>')}
      ${line('Making', running.length
    ? running.map((h) => ui.itemName(h.output?.item_id ?? h.recipe?.output_id ?? h.making)).join(', ')
    : '<i>idle</i>')}
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
        send('build-upgrade', { id: f.id, ids: ui.pickedIds() });
      } else if (what === 'downgrade') {
        send('build-downgrade', { id: f.id, ids: ui.pickedIds() });
      } else if (what === 'remove') {
        // `ids` is the whole selection and `id` is the one this menu is named
        // after — both, because `targets` prefers the list and a client that has
        // not reloaded still sends only the singular. Unfiltered on purpose: the
        // server folds the refusals and says how many would not go, and a client
        // that pruned the list would be a second opinion about a rule the server
        // already owns.
        // `region` for the reason Ctrl+C sends one: what a copy carries, a
        // remove takes, and a selection nobody dragged sends null and is the old
        // verb exactly.
        send('build-remove', { id: f.id, ids: ui.pickedIds(), region: ui.pickRegion });
        ui.closePanel();
      }
    });
  });

  // Not through `withBuildMode`, unlike every verb in the foot: taking stock
  // off a shelf is shopkeeping, not building, and the server gates it on
  // standing there instead. The menu stays open — the count on this row is
  // what tells you it worked, and it drops as you arrive.
  //
  // Through `errandHold` and not `send`, because a walk-to errand only NAMES
  // the board: the ring still has to wind on arrival, and it winds while a
  // button is down (`Game.stepActions`). A press on the shop floor is a finger
  // that stays down for the journey, and a click on a menu row is down and up
  // in the same millisecond — so this button sent you to the shelf and left you
  // standing at it with the action armed and nothing pressing it, which is a row
  // that promises an armful and delivers a walk.
  ui.el.panelBody.querySelectorAll('[data-take]').forEach((el) => {
    el.onclick = () => ui.errandHold(
      () => send('take', { shelfId: f.id, itemId: el.dataset.take }),
    );
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

  wireBoardOrder(ui, f, send);

  // `[data-up]` retired with the hand-rolled deals table: a deal is a row now,
  // and a row carries its own `run`.
}

/** How long a press has to settle on a board before it picks it up, in ms. */
const BOARD_DWELL_MS = 200;
/** ...and how far it may wander in that time and still count as settled. */
const BOARD_SLOP = 6;

/**
 * Drag a board up or down the unit.
 *
 * Where goods sit on a shelf used to be a fact about delivery order — the list
 * is what arrived when — and this is the one arrangement in the shop you can
 * see from across it, so "put the cereal at eye level" was a sentence with
 * nowhere to be said. See `Game.orderBoards`.
 *
 * A HOLD, then a drag, for the reason the world's move-drag is one: this list
 * lives inside a panel you scroll by dragging it, so a bare drag is already
 * spoken for and a row that moved on the first pixel would make the menu
 * un-scrollable on a phone. Under `BOARD_DWELL_MS` the press is left alone
 * entirely — no capture, no preventDefault — so the scroll gets it untouched;
 * past it the pointer is captured and the scroll never sees another event.
 *
 * The DOM is reordered as you go rather than a gap being drawn: the answer to
 * "where would it land" is the list itself, so there is nothing to keep in step
 * with anything. What that costs is the repaint guard below — the menu rebuilds
 * from the snapshot ten times a second, and a rebuild mid-drag would throw away
 * the element under your finger.
 *
 * A press that never settles is still a press: nothing here calls
 * `preventDefault` or `stopPropagation` before the dwell, so every button on the
 * row goes on working exactly as it did — and a press that STARTED on one of
 * them is never a drag at all, or the four squares on the right of each row
 * would each be a handle for the row they sit on.
 */
function wireBoardOrder(ui, f, send) {
  const list = ui.el.panelBody.querySelector('.fx-boards');
  if (!list) return;
  const rows = [...list.querySelectorAll('[data-board]')];
  if (rows.length < 2) return;          // nothing to reorder

  for (const row of rows) {
    row.addEventListener('pointerdown', (e) => {
      // Left button or a finger only, and never a press that landed on a
      // control: `closest` rather than a tag test, because the buttons contain
      // an SVG and the target is usually a path inside it.
      if (e.button !== 0 || e.target.closest('button')) return;
      const startY = e.clientY;
      let live = false;
      const at = () => [...list.querySelectorAll('[data-board]')];

      const timer = setTimeout(() => {
        live = true;
        ui.boardDragging = true;       // hold the repaint off — see `tickFixture`
        row.classList.add('moving');
        row.setPointerCapture(e.pointerId);
      }, BOARD_DWELL_MS);

      const move = (ev) => {
        // THE RELEASE THAT NEVER ARRIVED — and here it is not just a row stuck
        // to the pointer. `boardDragging` holds the menu's repaint off, so a
        // drag nothing ever ends is a fixture menu frozen at the snapshot it
        // was on: stock that stops counting down, an upgrade that never greys
        // out, all of it looking like the panel having died rather than like a
        // press. See `healLostPress` in client/main.js for the same repair on
        // the world's own drags.
        if (ev.buttons === 0) { done(false); return; }
        if (!live) {
          // Moved before it settled: this is the panel's scroll, and it is
          // already happening — all this has to do is stop taking it over.
          if (Math.abs(ev.clientY - startY) > BOARD_SLOP) { clearTimeout(timer); done(false); }
          return;
        }
        // Which side of a neighbour's middle the pointer is on. Only the two
        // it could swap with are considered, so one move is one place — a
        // sweep down the list steps through it rather than jumping to the end
        // and leaving the rows it passed unmoved.
        const els = at();
        const i = els.indexOf(row);
        const up = els[i - 1];
        const down = els[i + 1];
        if (up && ev.clientY < up.getBoundingClientRect().bottom - up.offsetHeight / 2) {
          list.insertBefore(row, up);
        } else if (down && ev.clientY > down.getBoundingClientRect().top + down.offsetHeight / 2) {
          list.insertBefore(row, down.nextSibling);
        }
      };

      const done = (drop) => {
        clearTimeout(timer);
        row.removeEventListener('pointermove', move);
        row.removeEventListener('pointerup', up);
        row.removeEventListener('pointercancel', cancel);
        row.removeEventListener('lostpointercapture', cancel);
        if (!live) return;
        live = false;
        row.classList.remove('moving');
        ui.boardDragging = false;
        // Sent only where it landed somewhere else. A hold that put the row
        // back where it started is a message that changes nothing, and every
        // one of those is a `persist()` and a snapshot in a co-op shop.
        const order = at().map((el) => el.dataset.board);
        if (drop && order.join() !== rows.map((el) => el.dataset.board).join()) {
          send('board-order', { shelfId: f.id, order });
        }
      };
      const up = () => done(true);
      const cancel = () => done(false);

      row.addEventListener('pointermove', move);
      row.addEventListener('pointerup', up);
      row.addEventListener('pointercancel', cancel);
      // Capture is taken above, at the dwell, so it can also be taken away —
      // and this row is the one place where losing it silently stops the whole
      // menu updating. Fires after an ordinary release with `live` already
      // false, where `done` returns having removed these listeners twice.
      row.addEventListener('lostpointercapture', cancel);
    });
  }
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
  // Said first when it is there, and it never shares a line with the rest: this
  // is not a better till, it is the shop losing its queues, and a rung that
  // reads "works 1.2× as fast, bills 12 at once" buries the only half anybody
  // is buying. The cost is named here too, because it is the one rung whose
  // price is not the number on the button.
  if ((tier.covers ?? 0) > 0) {
    return `No queue at all — shoppers walk out and are billed on the way. `
      + `Reads ${tier.covers} at once; past that it starts missing things.`;
  }
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
    // Every tray, the way `dumpStation` empties every tray — a twin whose count
    // ignored the second one would grey Remove out with goods still on it.
    const trays = (live?.lines ?? [{ output: live?.output ?? null }])
      .reduce((sum, slot) => sum + (slot.output?.qty ?? 0), 0);
    const n = Object.values(live?.contents ?? {}).reduce((a, b) => a + b, 0) + trays;
    return { n, blurb: 'Tips the hopper into crates. A batch going is left to finish.' };
  }
  if (f.kind === 'plot') {
    const n = live?.crop_id ? 1 : 0;
    return { n, blurb: 'Pulls the crop and leaves the bed rough. A half-grown crop is lost.' };
  }
  if (f.kind === 'pen') {
    // Whatever is standing in the gateway, and never the animal — the piece IS
    // the animal, so selling the pen is what happens to it. Nobody is asked to
    // rehome a cow before tearing the fence down.
    const n = live?.qty ?? 0;
    return { n, blurb: `${n}× ${ui.itemName(live?.item_id)} into a crate at the gate.` };
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
