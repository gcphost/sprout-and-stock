/**
 * One menu per unit.
 *
 * Tapping a name on the roster opens that unit, exactly the way tapping a
 * shelf opens that shelf — and for the same reason. Two stockers are two
 * machines, and the only thing that can tell them apart is which row you
 * pressed.
 *
 * Everything on this screen is *theirs*, not their kind's: the job list was
 * copied off the kind the day they were taken on, and from then on it is a row
 * in the roster that only this menu writes to.
 *
 * Functions take `ui` first rather than living on it, like `fixture-menu.js` —
 * this reads the snapshot and sends messages, it isn't part of the HUD's state.
 */

import { ICONS, icon } from './icons.js';
import { money, signed } from './money.js';
import { actIcon } from './fixture-menu.js';
// A hire's avatar asks the same question a palette tile does — tap for the
// obvious thing, hold for what it comes in — so it asks it over the same
// interval rather than one of its own.
import { HOLD_MS } from './bar.js';
import { artForWorker, spinForWorker } from './thumb.js';
// One sell-back rate for the whole shop, not one per ladder: a rung handed back
// is worth what a fixture torn out is worth, and two copies of that number would
// be two different amounts of money — which is the argument the constant itself
// makes about the button printing it and the server paying it.
import { FIXTURE_REFUND } from '../shared/build.js';
import { lotStacks, lotTotal } from '../shared/lot.js';
// How much of a day there is to hand out. The same module the server refuses
// with, or the `+` offers a weight the shop hands straight back.
import {
  jobBudget, jobsAffordable, jobsTotal, JOB_POINTS_PER_RUNG,
} from '../shared/jobs.js';

/** Worker names and kind names come out of the database, so never raw. */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/**
 * What each job is called, what picking it means, and what it looks like from
 * across the shop.
 *
 * Keyed by the vocabulary in `shared/schemas.js`, which arrives with the
 * catalog rather than being copied here — so a tenth job added there still
 * lists, under its own name, with no blurb. A menu that silently omitted a job
 * would be a job you had no way to give anybody.
 *
 * TWO descriptions per job, and the split is about the shape of the list rather
 * than about taste. The grid is two columns of a 430px panel, so a row has
 * roughly twenty characters beside its stepper: every sentence long enough to
 * be *useful* wrapped to two or three lines, and a list whose rows are three
 * lines tall is a list you scroll to reach the buttons under it — which is the
 * thing the three-region layout above exists to prevent. So `blurb` is what
 * fits on the line, and `detail` is the sentence, on the hover. The row is a
 * label you scan down; the tooltip is the one you stopped on.
 *
 * Which makes the constraint on `blurb` real rather than stylistic: it has to
 * stay short enough not to wrap at this width. It says what the job IS in as
 * few words as will carry it, and everything conditional, every caveat and
 * every "and also" belongs in `detail`.
 */
const JOB_INFO = {
  serve: {
    name: 'Serve',
    doing: 'on the till',
    blurb: 'Take money.',
    detail: 'Stand at a till and ring up whoever is waiting.',
  },
  restock: {
    name: 'Restock',
    doing: 'ordering stock',
    blurb: 'Order stock in.',
    detail: 'Buy wholesale to refill a shelf that has run bare.',
  },
  unload: {
    name: 'Unload',
    doing: 'unloading a pallet',
    blurb: 'Clear the bay.',
    detail: 'Carry pallets in off the delivery bay and put them away.',
  },
  shelve: {
    name: 'Shelve',
    doing: 'filling a shelf',
    blurb: 'Fill shelves.',
    detail: 'Put whatever is in their hands onto a shelf that will take it.',
  },
  // One row, not three. Tilling, sowing and picking are three steps of one loop
  // over the same beds — nobody ever wanted the middle one on its own — so three
  // lines of a twenty-point budget bought a decision that had one setting.
  farm: {
    name: 'Farm',
    doing: 'working the beds',
    blurb: 'Work the beds.',
    detail: 'Pick what is ripe, sow what is turned, and turn what is rough.',
  },
  craft: {
    name: 'Craft',
    doing: 'working the appliances',
    blurb: 'Run appliances.',
    detail: 'Fetch ingredients, load an appliance, and collect what it made.',
  },
  tidy: {
    name: 'Tidy',
    doing: 'tidying up',
    blurb: 'Crate strays.',
    detail: 'Crate up anything with nowhere to go, and carry rubbish out to the skip.',
  },
  // NOT "Shop hand" — that is the name of a worker *kind* (`shop-hand`), and a
  // job sharing it would read as the one job that worker does.
  merchandise: {
    name: 'Merchandise',
    doing: 'working the shelves',
    blurb: 'Fix boards.',
    detail: 'Clear boards nothing sells off, and merge two half-empty ones.',
  },
  // One row, like `farm`, and for the same reason: filling a stockroom and
  // emptying one are two steps of a single loop, and a hire told only to fill
  // them builds a pile in a room.
  ferry: {
    name: 'Run the back',
    doing: 'running the back',
    blurb: 'Work the stockrooms.',
    detail: 'Carry whole crates off the bay into the stockroom nearest where '
      + 'they sell, and refill shelves out of it. Does nothing until you mark a '
      + 'unit as a stockroom.',
  },
};

/** Highest weight the stepper will climb to. Authored lists sit at 1–10. */
const WEIGHT_MAX = 10;

/**
 * How long "tap again" stays armed, anywhere in this UI that asks twice.
 *
 * Removing a shelf hands half the money back and you can build another one.
 * Letting someone go refunds nothing, so a mis-tap in a scrolling list costs a
 * whole hire — which was the one place in this UI worth asking twice, and is now
 * one of two: taking somebody ON is the same decision pointed the other way, and
 * `UI.armHire` imports this rather than keeping its own 4000. It was two
 * constants tied by a comment in each saying they must agree, which is the shape
 * a number takes right before somebody tunes one of them.
 *
 * It is also a duration something is DRAWN from — the armed hire tile drains a
 * line over exactly this long (`--arm` in `bar.js`) — so it is the window and
 * the animation both, the way `.tool.holding` is `HOLD_MS` wearing a colour.
 */
export const ARM_MS = 4000;

/**
 * How long one turn of the avatar takes.
 *
 * Slow on purpose: this is a card you read, and a bot whipping round in the
 * corner of it competes with every number beside it. Paired with
 * `SPIN_FRAMES` it is also the step length — six frames a second — which is
 * where a flipbook stops reading as a stutter.
 */
const SPIN_SECONDS = 4;

const titleCase = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const infoFor = (job) => JOB_INFO[job]
  ?? { name: titleCase(job), doing: String(job), blurb: '', detail: '' };
const mult = (n) => `${Number(n) % 1 === 0 ? n : Number(n).toFixed(1)}×`;

/** The roster row for one hire — the record, not the body walking about. */
export const rosterEntry = (ui, id) => (ui.state?.roster ?? []).find((e) => e.id === id) ?? null;

/** The NPC on the floor, or null if their kind was deleted out from under them. */
export const bodyOf = (ui, entry) => (ui.state?.players ?? [])
  .find((p) => p.hire === entry.id) ?? null;

/** What a hire is doing right now. Read by the roster list and by their menu. */
export function doingNow(ui, entry, body) {
  if (!body) return 'not turned up — their kind was deleted';
  // A charge outranks what is in their hands: "carrying 4× tomato" while they
  // are stood on a dock topping up is the wrong half of the truth.
  if (body.job === 'break') return onBreakNow(ui, body);
  if (body.carry) {
    // Pile by pile. A hire with mixed hands is doing a trip that clears three
    // boards, and "carrying 11" is the one reading that says nothing about it.
    return `carrying ${lotStacks(body.carry)
      .map((k) => `${k.qty}× ${ui.itemName(k.item_id)}`).join(', ')}`;
  }
  return body.job ? infoFor(body.job).doing : 'looking for something to do';
}

/**
 * The authored line for the charge they are on, or that they are off to take one.
 *
 * A charge taken out of boredom says so. It is the same picture as any other —
 * a unit in the break room with a mug — and the difference is the whole of what
 * a promoted one does differently, so a menu that could not tell you would make
 * "wandered off while I had nothing for them" read as "wandered off".
 */
function onBreakNow(ui, body) {
  const p = (ui.catalog.pastimes ?? []).find((x) => x.id === body.pastime);
  const doing = p ? p.doing : 'off to charge';
  return body.idleCharge ? `${doing} — nothing to do` : doing;
}

/** Worn out enough that the menu should say so rather than just show a bar. */
const SPENT = 0.25;

/** "$4 a day · serve, unload, shelve" — enough to choose by, in one clause. */
export function kindSummary(kind) {
  const jobs = (kind.jobs ?? []).map((j) => infoFor(j.job).name.toLowerCase()).join(', ');
  return kind.wage > 0 ? `${money(kind.wage)} a day · ${jobs}` : jobs;
}

/**
 * Open the menu for one hire.
 *
 * Takes the roster id rather than the record, because the record is re-sent
 * whole in every snapshot: holding the one we opened with would show a job list
 * that stopped updating the moment somebody else changed it.
 */
export function showWorker(ui, workerId) {
  const entry = rosterEntry(ui, workerId);
  if (!entry) { ui.closePanel(); return; }

  // The paint card belongs to the avatar you opened it off, and this function
  // is also every redraw — so it closes when the person changes and not when
  // their energy ticks. Before `workerRef` is written, which is what says so.
  if (ui.workerRef !== workerId) ui._wkLook = false;

  ui.openPanel = 'worker';
  // Like a fixture's menu, this isn't a section, so nothing on the rail is lit.
  ui.rail.setOpen(null);
  // Through the setter, so the shop floor marks who this menu is about — the
  // panel names them and the world is where you are looking. Same deal
  // `setFixtureRef` makes, and it matters more here because they walk.
  ui.setWorkerRef(workerId);
  // One callback, called every snapshot, that redraws only when what this shows
  // has actually moved. The same hook the fixture menu registers.
  ui.panelTick = tickWorker;

  const body = bodyOf(ui, entry);
  const kind = kindOf(ui, entry);
  ui._wkMenuKey = workerSignature(ui, entry, body);

  const weights = new Map((entry.jobs ?? []).map((j) => [j.job, j.weight]));
  const vocabulary = jobVocabulary(ui, entry);

  // Three regions, not one list. Who this is stays at the top and what you can
  // do about it stays at the bottom, because the middle is the only part with
  // no ceiling on its length — the job vocabulary is server-side and grows —
  // and it was pushing Promote and Let-them-go off the end of a scroll that
  // started with five lines of read-out you had already read.
  const parts = [`<div class="pnl-head">${profile(ui, entry, kind, body)}</div>`];

  // The one pane that scrolls, and the only thing left that could — there is no
  // second list to tab to any more, because a look is picked off the avatar that
  // is wearing it. What tabs bought was keeping a job list and a paint list off
  // one screen; what they cost was the paint being three presses from a picture
  // of the thing being painted, which is the whole argument for `thumb.js`.
  //
  // TWO COLUMNS, because the list is a fixed vocabulary of eight short rows and
  // one column of them is a scroll for no reason. `auto-fit` rather than a flat
  // `1fr 1fr`: the panel is `min(430px, 100vw - 24px)`, so on a phone the same
  // grid is one column and the rows do not squeeze to a stepper and an ellipsis.
  //
  // The heading carries the budget and there is no prose under the list. Three
  // paragraphs explaining that a weight is a share of a day is a thing you read
  // once and then scroll past for the rest of the game — and a counter running
  // out as you press `+` teaches the same rule in the place you are pressing.
  const spent = jobsTotal([...weights].map(([job, weight]) => ({ job, weight })));
  const budget = jobBudget(kind, entry.tier);
  parts.push(`<div class="pnl-mid"><div class="sep">Directives${
    kind ? `<b class="wk-cap${spent > budget ? ' over' : ''}">${round1(spent)}<i>/${budget}</i></b>` : ''}</div>`
    + `<div class="wk-jobs">${vocabulary
      .map((j) => jobRow(j, weights.get(j) ?? 0, spent < budget)).join('')}</div>`
    + '</div>');

  const foot = [];

  // First, because it is the only verb here that costs nothing, changes
  // nothing and can be pressed twice — and because it is the one you want
  // *while* reading the rest. A hire whose kind was deleted has no body to
  // follow, which is the same `!body` that greys the read-out at the top.
  const watching = ui.follow === entry.id;
  foot.push(actIcon('follow', ICONS.camera,
    watching ? 'Stop following' : 'Follow them',
    watching
      ? 'The camera comes back to you. Walking anywhere does the same.'
      : 'The camera rides on them until you walk somewhere yourself.',
    watching ? 'Stop' : 'Follow', { off: !body, on: watching }));

  // Both rungs or neither, which is the fixture menu's rule and is here for the
  // identical reason: the squares are `flex: 1`, so a row that gains a sixth
  // narrows and shifts every one of them under a pointer that has not moved.
  // Installing firmware slid Roll back under your finger, so the obvious second
  // press undid what you had just paid for — and at the top of the ladder the
  // Install square vanishes and does the same thing the other way.
  const next = nextTier(kind, entry.tier);
  const back = prevTier(kind, entry.tier);
  if (next || back) {
    const afford = next && (ui.state?.cash ?? 0) >= next.cost;
    // The rung's name is authored and can be any length, so it goes in the
    // wrapping description rather than the one-line title — the same call the
    // fixture menu makes, for the same reason. The title is the verb, which is
    // short and fixed; the line under it says what you are actually buying.
    // The one perk that is not on the rung and not a number: everything above
    // the bottom rung takes itself off to charge when the shop is quiet, so it
    // is NEW at this step and only at this step. Said on the button that grants
    // it, because a unit that starts wandering off with no warning reads as
    // something having gone wrong with the promotion you just paid for.
    const learns = next?.tier === 2 ? ' Starts charging itself when there is nothing on.' : '';
    const blurb = next ? `${esc(next.name)} — ${tierBlurb(next, JOB_POINTS_PER_RUNG)}${learns}` : '';
    foot.push(actIcon('promote', ICONS.tierup, 'Install firmware',
      next ? (afford ? blurb : `${blurb} You cannot afford it yet.`)
        : 'Already on the latest firmware there is.', 'Install',
      // A purely cosmetic rung is free, and `$0` reads as a broken number.
      { off: !afford, right: next && next.cost > 0 ? money(next.cost) : next ? 'free' : '' }));

    // The way back down, and the only rung on any ladder where going down has an
    // ongoing argument for it: a grade is charged every day in wages, so this is
    // a decision rather than an undo.
    const saving = back?.saves > 0 ? ` Saves ${money(back.saves)} a day in lease.` : '';
    // ...and the same sentence pointed the other way. Losing it silently is the
    // half of a rollback nobody would connect to the button.
    const forgets = back?.tier === 1 ? ' Stops charging itself between jobs.' : '';
    foot.push(actIcon('demote', ICONS.tierdown, 'Roll back',
      back
        ? `Back to ${esc(back.name)} — ${tierBlurb(back, -JOB_POINTS_PER_RUNG)}${forgets}${saving} Half of that firmware back.`
        : 'Nothing under them — this is the firmware they shipped with.',
      'Roll back', { off: !back, right: back && back.refund > 0 ? signed(back.refund) : '' }));
  }

  // The latch has to be visible in a square, and it used to be visible in the
  // row's own title — "Tap again to let them go" is a sentence, and a sentence
  // is what a caption is not. So the caption becomes the question and the
  // square lights up: `armed` is the one state here you must not be able to
  // walk past, because the next tap is a person leaving and nothing comes back.
  const armed = armedToFire(ui, entry.id);
  foot.push(actIcon('fire', ICONS.remove,
    armed ? 'Tap again to decommission' : 'Decommission',
    armed ? 'It wipes itself and walks out now. Nothing comes back.'
      : 'No refund — a unit off its lease is worth nothing to anyone.',
    armed ? 'Sure?' : 'Retire',
    { danger: true, armed }));

  parts.push(`<div class="pnl-foot"><div class="fx-verbs">${foot.join('')}</div></div>`);

  // Who. Nudging a weight or picking a paint redraws the whole menu and must
  // keep your place in it; opening somebody else is a different list and must
  // not.
  ui.showPanel(`${icon(entry.kind, ICONS.staff)} ${esc(entry.name)}`, parts.join(''),
    `worker:${entry.id}`);
  wireWorkerMenu(ui, entry, weights, vocabulary);
}

/**
 * Keep the open menu honest from the snapshot: what they are doing changes
 * every few seconds, another player can reassign them, and either of you can
 * let them go while it is open.
 */
function tickWorker(ui) {
  if (ui.openPanel !== 'worker' || !ui.workerRef) return;
  const entry = rosterEntry(ui, ui.workerRef);
  if (!entry) { ui.closePanel(); return; }
  if (workerSignature(ui, entry, bodyOf(ui, entry)) !== ui._wkMenuKey) showWorker(ui, ui.workerRef);
}

/**
 * Everything the open menu draws from, so it redraws when any of it moves —
 * and only then, rather than ten times a second over a live canvas.
 *
 * The fire latch is in here on purpose: it expires on a timer, and without it
 * in the signature the row would still be sat there saying "tap again" long
 * after tapping again had stopped doing anything.
 */
function workerSignature(ui, entry, body) {
  return JSON.stringify([entry, body?.job ?? null, body?.carry ?? null,
    // Rounded, or a bar that moves by a thousandth redraws the panel at 10Hz.
    body?.pastime ?? null, Math.round((body?.energy ?? 1) * 20),
    ui.state?.cash?.toFixed(0), ui.catalog.version, armedToFire(ui, entry.id),
    // Walking away turns the follow off from outside this menu, and the verb
    // has to stop saying Following when it does.
    ui.follow === entry.id,
    // The paint card is opened and shut from inside this menu, so a redraw
    // driven by the snapshot has to put it back the way you left it — without
    // this the next sale closes a rack you are choosing out of. `entry` above
    // already carries the skin, so which one is lit needs nothing extra.
    !!ui._wkLook]);
}

/** The authored kind behind a hire, or null if it has since been deleted. */
const kindOf = (ui, entry) => (ui.catalog.workers ?? []).find((w) => w.id === entry.kind) ?? null;

/**
 * Every job this person could be given, in a stable order.
 *
 * The server's vocabulary first, then anything they are already doing that
 * isn't in it — a job you cannot see is a job you cannot turn off.
 */
function jobVocabulary(ui, entry) {
  const known = ui.catalog.jobs?.length ? ui.catalog.jobs : Object.keys(JOB_INFO);
  return [...new Set([...known, ...(entry.jobs ?? []).map((j) => j.job)])];
}

/**
 * The read-out at the top: who this is, what they look like, and what they are
 * doing about it.
 *
 * A profile rather than five lines of label-and-value, and the avatar is what
 * makes it one — a name and a model number describe a machine, and the machine
 * itself is stood right there. Everything else is the same five readings, in two
 * columns beside it instead of five rows under it, which costs the head about
 * forty pixels less and hands them to the list below.
 *
 * Doing spans both columns because it is the only one that is a sentence, the
 * only one that changes while you watch, and the longest — put in a column it
 * wraps to three lines and sets the height of the row it is in.
 *
 * The four figures under it stay in two columns, and they stay on ONE LINE
 * each. Firmware is why that had to be said: a rung's name is AUTHORED — "New
 * behind the counter" is a real one — so unlike Charge, Model and Lease its
 * length is content rather than a fact about the layout, and wrapped it dragged
 * the label beside it out of line with the row above. That reads as the grid
 * being broken rather than as a long name. Clipped with the whole of it on the
 * hover, which is the deal every row in this panel already makes with its
 * caption; spanning the row instead was tried and is worse, because it turns a
 * tidy 2×2 into a widow.
 */
function profile(ui, entry, kind, body) {
  // `hint` goes on the element rather than into the value, because a figure in
  // here is clipped to one line (see `.wk-grid` in index.html) and the hover is
  // where the whole of a long one lives — the same deal every row in this panel
  // makes with its caption.
  const line = (label, value, hint = null) => `<div class="fx-line"${
    hint ? ` title="${hint}"` : ''}><span>${label}</span><b>${value}</b></div>`;
  const tiers = kind?.tiers?.length ? kind.tiers : null;
  const rung = tiers?.[Math.min(Math.max(1, entry.tier ?? 1), tiers.length) - 1] ?? null;
  const looks = skinChoices(ui);
  return `<div class="wk-profile">
    ${avatar(ui, entry, kind, looks.length > 1)}
    <div class="wk-facts">
      ${line('Doing', esc(doingNow(ui, entry, body)))}
      <div class="wk-grid">
        ${energyLine(body)}
        ${line('Model', esc(kind?.name ?? entry.kind))}
        ${rung ? line('Firmware', esc(rung.name), esc(rung.name)) : ''}
        ${kind?.wage > 0 ? line('Lease', `${money(wageAt(kind, entry.tier))} a day`) : ''}
      </div>
    </div>
    ${ui._wkLook && looks.length > 1 ? paintCard(ui, entry, kind, looks) : ''}
  </div>`;
}

/**
 * The hire, turning, and the one control in the game that is a picture of what
 * it changes.
 *
 * Tap repaints them and hold asks what paints there are — the palette tile's
 * sentence, over the same `HOLD_MS`, and for the same reason it grew there: a
 * look is cosmetic enough that a hidden gesture would simply read as the game
 * not having any. Hence the chevron, which is that door with a handle on it.
 *
 * The phase is stamped as a NEGATIVE DELAY off the page clock, and that is the
 * whole of what makes the turn survive this menu. Every snapshot that moves a
 * number in the head redraws the panel — a sale moves the cash the foot prices
 * against, so on a busy afternoon that is several times a second — and a fresh
 * element starts its animation at frame zero. A bot that jumped back to facing
 * you every time somebody paid would read as the shop being what stopped it.
 */
function avatar(ui, entry, kind, pickable) {
  const skin = skinById(ui, entry.skin);
  const frames = spinForWorker(kind, entry.tier, skin);
  const art = frames
    // One long strip of stills slid sideways by `steps()`. A negative delay is
    // "start this far in", so `-(now mod loop)` is exactly where the last copy
    // of this element had got to.
    ? `<span class="wk-turn" style="--n:${frames.length};--spin:${SPIN_SECONDS}s;animation-delay:${
      (-(performance.now() / 1000) % SPIN_SECONDS).toFixed(2)}s">${
      frames.map((f) => `<span>${f}</span>`).join('')}</span>`
    : `<span class="wk-still">${artForWorker(kind, entry.tier, skin) ?? ICONS.staff}</span>`;
  // A div where there is nothing to choose between — a shop with no skins
  // authored has one look, and a button that only ever picks it is a button
  // that lies about being one.
  if (!pickable) return `<div class="wk-face">${art}</div>`;
  return `<button class="wk-face" data-face="1"
    title="Tap to repaint them. Hold for the range."
    aria-label="Repaint">${art}<span class="more">▾</span></button>`;
}

/**
 * Every paint they could be wearing, as pictures of them wearing it.
 *
 * A list of rows rather than a wrapped block of chips, and the same `.shape`
 * row the build bar's shape card is made of — it is the same question with the
 * same shape of answer, and two spellings of "here is that thing in its other
 * looks" is two things to keep matching.
 *
 * The picture is the bot, not a swatch of the colours. It used to be three
 * colour bars, which was the honest picture while this was a tab of names; with
 * the card hanging off an avatar of the machine, a row that showed paint chips
 * next to a robot would be answering in a different language from the question.
 */
function paintCard(ui, entry, kind, looks) {
  const here = entry.skin ?? null;
  return `<div class="wk-skins">${looks.map((s) => `
    <button class="shape${s.id === here ? ' on' : ''}" data-skin="${esc(s.id ?? '')}"
      title="${esc(s.blurb)}">
      <span class="ico art">${artForWorker(kind, entry.tier, s.row) ?? ICONS.staff}</span>
      <span class="nm">${esc(s.name)}</span>
    </button>`).join('')}</div>`;
}

/**
 * The looks on offer, "as built" first.
 *
 * A real row with a null id rather than a special case, the same shape
 * `variantsOf` gives a fixture's Standard — it is how you get back out of a
 * paint without there having to be a default row somebody could delete.
 *
 * Nothing here is priced, and that is the point rather than an omission: a
 * paint moves no number, so there is no affordability to check and no
 * confirmation to ask for. Compare the foot of this menu, where both are the
 * whole story.
 */
function skinChoices(ui) {
  return [
    { id: null, name: 'As built', row: null, blurb: 'The colours their kind was drawn in.' },
    ...(ui.catalog.skins ?? []).map((s) => ({
      id: s.id, name: s.name, row: s, blurb: extrasBlurb(s),
    })),
  ];
}

const skinById = (ui, id) => (id ? (ui.catalog.skins ?? []).find((s) => s.id === id) ?? null : null);

/**
 * Round to the next paint, which is what a tap on the avatar means.
 *
 * Wrapping past the end lands back on "as built", so the tap alone can reach
 * every look and get back out of one — the card is the shortcut, not the only
 * way through.
 */
function cycleSkin(ui, entry) {
  const looks = skinChoices(ui);
  if (looks.length < 2) return;
  const at = looks.findIndex((s) => s.id === (entry.skin ?? null));
  const next = looks[(Math.max(0, at) + 1) % looks.length];
  ui.net.send('set-skin', { workerId: entry.id, skin: next.id });
}

/**
 * How much is left in the cell, as a bar and a word.
 *
 * A bar on its own says a number; the word says what it *means* for them, which
 * is the thing you would otherwise have to learn by watching a unit slow down
 * and wander off to a dock. A worker stopping for reasons the player cannot see
 * reads as the same bug this whole section came out of.
 */
function energyLine(body) {
  if (body?.energy == null) return '';
  const e = Math.max(0, Math.min(1, body.energy));
  const word = e > 0.66 ? 'charged' : e > SPENT ? 'draining' : 'flat';
  return `<div class="fx-line"><span>Charge</span>
    <b class="wk-energy${e <= SPENT ? ' low' : ''}">
      <i style="width:${Math.round(e * 100)}%"></i>${word}
    </b></div>`;
}

/**
 * One job, with the dial that says how much of this person's day it gets.
 *
 * Nothing *is* off. There is no separate checkbox, because a job at weight zero
 * and a job missing from the list are the same thing to the sim, and two
 * controls standing for one number is how they end up disagreeing.
 *
 * `room` is whether the budget has anything left in it, and it greys every `+`
 * in the list at once rather than only the one you are over — there is one pot
 * and every directive spends out of it, so a row that still offered a point
 * would be offering somebody else's. `disabled` rather than a refusal on the
 * press, because the counter in the heading is right there saying why: a
 * stepper that looks live and does nothing is the thing that reads as broken.
 *
 * Its own row rather than `ui.rowHtml`, for the same reason `act` in the
 * fixture menu is: that shape carries at most one button, and a stepper is
 * three controls. The classes are the shared ones, so it still matches.
 */
function jobRow(job, weight, room) {
  const info = infoFor(job);
  const off = weight <= 0;
  // The short one on the line, the long one on the hover — see `JOB_INFO`. The
  // title carries the NAME too, because a tooltip that only restates the row it
  // is over reads as a bug, and this one is a different sentence.
  return `<div class="row wk-job${off ? ' owned' : ''}" title="${esc(`${info.name} — ${info.detail || info.blurb}`)}">
    <div class="name">${esc(info.name)}<span class="tags">${esc(info.blurb)}</span></div>
    <div class="fx-price wk-w">
      <button data-job="${esc(job)}" data-step="-1" aria-label="less"${off ? ' disabled' : ''}>−</button>
      <b>${off ? '·' : round1(weight)}</b>
      <button data-job="${esc(job)}" data-step="1" aria-label="more"${room ? '' : ' disabled'}>+</button>
    </div>
  </div>`;
}

/** A weight is authored as a decimal and stepped as an integer, so print both. */
const round1 = (n) => (Number(n) % 1 === 0 ? String(n) : Number(n).toFixed(1));

/**
 * Say what a paint brings beyond colour.
 *
 * A bolted-on piece is the one thing about a skin the picture beside it may not
 * tell you — a part the size of a badge is a few pixels at avatar size, and it
 * is the only way a look changes the silhouette rather than the palette.
 */
function extrasBlurb(skin) {
  const n = skin.extras?.length ?? 0;
  return n ? `Repaints them, and adds ${n === 1 ? 'a piece' : `${n} pieces`}.` : 'Repaints them head to toe.';
}

/** The next rung up, or null when they are already at the top of the ladder. */
function nextTier(kind, tier) {
  const tiers = kind?.tiers ?? [];
  const at = Math.min(Math.max(1, Math.trunc(tier ?? 1)), Math.max(1, tiers.length));
  const next = tiers[at];
  return next ? { ...next, tier: at + 1 } : null;
}

/**
 * The rung below, what stepping back onto it hands over, and what it saves.
 *
 * The saving is the reason this ladder has a way down at all: a fixture's rung
 * is paid for once, and a hire's is charged again every morning. So the blurb
 * carries the wage as money per day rather than as the multiplier the rung is
 * authored with — `0.8×` of a number nobody has in their head is not a figure
 * anybody can decide on.
 */
function prevTier(kind, tier) {
  const tiers = kind?.tiers ?? [];
  const at = Math.min(Math.max(1, Math.trunc(tier ?? 1)), Math.max(1, tiers.length));
  if (at <= 1) return null;
  const below = tiers[at - 2];
  if (!below) return null;
  return {
    ...below,
    tier: at - 1,
    refund: (tiers[at - 1]?.cost ?? 0) * FIXTURE_REFUND,
    saves: wageAt(kind, at) - wageAt(kind, at - 1),
  };
}

/**
 * What this shop actually pays somebody on a given rung, a day.
 *
 * The kind carries the wage and the rung scales it, which is exactly how
 * `payWages` on the server adds it up — and it is why the read-out at the top
 * of this menu could not go on printing `kind.wage`: that is what a new hire
 * costs, and it stops being what anybody costs the moment they are promoted.
 */
function wageAt(kind, tier) {
  const tiers = kind?.tiers ?? [];
  const at = Math.min(Math.max(1, Math.trunc(tier ?? 1)), Math.max(1, tiers.length));
  return (kind?.wage ?? 0) * (tiers[at - 1]?.wage_mult ?? 1);
}

/**
 * Say what a rung actually buys, out of its own numbers.
 *
 * `points` is the one thing on the list that is NOT read off the rung: every
 * rung grants the same slice of a day (`JOB_POINTS_PER_RUNG`), so it is the
 * caller that knows which way this move goes. It is also what retired the "no
 * change to any number" line for a hire — a rung with three multipliers of 1 on
 * it used to be a badge, and now it is always at least more to hand out.
 */
function tierBlurb(tier, points = 0) {
  const gains = [];
  if ((tier.speed_mult ?? 1) !== 1) gains.push(`walks ${mult(tier.speed_mult)} as fast`);
  if ((tier.pace_mult ?? 1) !== 1) gains.push(`starts the next job ${mult(tier.pace_mult)} as quick`);
  if ((tier.carry_mult ?? 1) !== 1) gains.push(`carries ${mult(tier.carry_mult)} as much`);
  // Said as the trip it buys rather than as the number it is. "Packs 3" is a
  // stat; "packs a crate of up to 3 kinds at the bay" is the thing you would
  // watch them do, and it is the only line here that describes a behaviour
  // rather than scaling one.
  if ((tier.packs ?? 0) > 0) {
    gains.push(`packs one crate of up to ${tier.packs} kind${tier.packs === 1 ? '' : 's'} at the bay`);
  }
  // Said as the shift you would watch, like `packs`. The number behind it is
  // how keen they are rather than how often, so printing it would be a figure
  // with nothing on screen to compare it against.
  if ((tier.arranges ?? 0) > 0) {
    gains.push(tier.arranges >= 0.66
      ? 'rearranges the shop — moves what sells to where people walk'
      : 'moves what sells to a better spot when one is obvious');
  }
  // Said as the walk it saves, like the two above. What the number sets is how
  // much of a short cut it takes to be worth diverting for, which is a
  // threshold in tiles and means nothing on its own.
  if ((tier.routes ?? 0) > 0) {
    gains.push(tier.routes >= 0.66
      ? 'plans their round — always works the nearest bed, queue or crate'
      : 'takes the nearer bed, queue or crate when it is an obvious short cut');
  }
  if (points > 0) gains.push(`${points} more directive points`);
  if (points < 0) gains.push(`${-points} fewer directive points`);
  return gains.length ? `${gains.join(', ')}.` : 'No change to any number — just a better badge.';
}

/**
 * Two things a press on the avatar can mean, told apart by how long it lasts —
 * the palette tile's gesture, wired the palette tile's way (`bar.js`).
 *
 * The chevron is the same door with a handle on it, so it is checked before the
 * tap: pressing the arrow is asking for the list, not for the next paint.
 *
 * The move guard matters here for a reason it does not on the bar: this panel is
 * DRAGGED by its header and sits over a canvas that pans, so a press that
 * travels is somebody moving something. Without it a slipped press repaints a
 * hire who was only in the way.
 */
function wireAvatar(ui, entry) {
  const face = ui.el.panelBody.querySelector('[data-face]');
  if (!face) return;
  let timer = null;
  let held = false;
  let from = null;
  const stop = () => { clearTimeout(timer); timer = null; };
  face.onpointerdown = (e) => {
    held = false;
    from = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      held = true;
      ui._wkLook = !ui._wkLook;
      showWorker(ui, entry.id);
    }, HOLD_MS);
  };
  face.onpointermove = (e) => {
    if (!timer || !from) return;
    if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > 8) stop();
  };
  face.onpointerup = stop;
  face.onpointerleave = stop;
  face.onpointercancel = stop;
  face.onclick = (e) => {
    stop();
    // The hold already answered this press. Cycling as well would repaint them
    // under a card that has just opened to let you choose.
    if (held) { held = false; return; }
    if (e.target.closest('.more')) {
      ui._wkLook = !ui._wkLook;
      showWorker(ui, entry.id);
      return;
    }
    cycleSkin(ui, entry);
  };
}

/** Is the let-go row armed for this person, and has that not timed out? */
function armedToFire(ui, id) {
  const arm = ui._wkFire;
  if (!arm || arm.id !== id) return false;
  if (performance.now() - arm.at > ARM_MS) { ui._wkFire = null; return false; }
  return true;
}

function wireWorkerMenu(ui, entry, weights, vocabulary) {
  wireAvatar(ui, entry);

  ui.el.panelBody.querySelectorAll('[data-skin]').forEach((el) => {
    el.onclick = () => {
      // Left open. Picking a paint is the one thing in this menu you would do
      // twice in a row — the card is a rack of them and the avatar behind it is
      // wearing whichever one you last pressed, so shutting it after every pick
      // would make comparing two looks a hold apiece.
      ui.net.send('set-skin', { workerId: entry.id, skin: el.dataset.skin || null });
    };
  });

  ui.el.panelBody.querySelectorAll('[data-step]').forEach((el) => {
    el.onclick = () => setWeight(ui, entry, weights, vocabulary, el.dataset.job, Number(el.dataset.step));
  });

  ui.el.panelBody.querySelectorAll('[data-act]').forEach((el) => {
    el.onclick = () => {
      // A toggle, and the only verb in this menu that sends the server nothing:
      // where your camera points is yours.
      if (el.dataset.act === 'follow') {
        ui.setFollow(ui.follow === entry.id ? null : entry.id);
        return;
      }
      if (el.dataset.act === 'promote') {
        ui.net.send('promote', { workerId: entry.id });
        return;
      }
      // Not armed the way letting them go is: a grade comes back for what half
      // of it cost, and the person is still standing there. Arming every verb
      // that moves money would make the one that cannot be undone look ordinary.
      if (el.dataset.act === 'demote') {
        ui.net.send('demote', { workerId: entry.id });
        return;
      }
      // Irreversible and unrefunded, so the first tap only arms it. The row
      // says so, and says it in the place the confirmation would have been.
      if (!armedToFire(ui, entry.id)) {
        ui._wkFire = { id: entry.id, at: performance.now() };
        showWorker(ui, entry.id);
        return;
      }
      ui._wkFire = null;
      ui.net.send('fire', { workerId: entry.id });
      ui.closePanel();
    };
  });
}

/**
 * Nudge one job's weight and send the whole list.
 *
 * The whole list, because that is what `assign-jobs` takes — one message that
 * replaces what they do, rather than a per-job protocol the server would have
 * to reassemble. Rebuilt in vocabulary order so the stored list stays readable.
 */
function setWeight(ui, entry, weights, vocabulary, job, step) {
  const now = weights.get(job) ?? 0;
  // Ceiling is the higher of the cap and where they already are, so a weight
  // authored above the cap can still be brought down rather than being stuck.
  const next = Math.max(0, Math.min(Math.max(WEIGHT_MAX, now), now + step));
  if (next === now) return;

  const jobs = vocabulary
    .map((j) => ({ job: j, weight: j === job ? next : (weights.get(j) ?? 0) }))
    .filter((j) => j.weight > 0);

  // The server refuses an empty list; say why here rather than letting them
  // press it and read a rejection.
  if (!jobs.length) { ui.toast('Everyone needs at least one job', true); return; }

  // ...and the same for the budget. The `+` is already greyed, so this only
  // fires on a weight authored past the cap or a hire left over their allowance
  // by a rollback — the one path where a step UP can still be asked for.
  const kind = kindOf(ui, entry);
  if (!jobsAffordable(kind, entry.tier, jobs, entry.jobs)) {
    ui.toast(`Only ${jobBudget(kind, entry.tier)} to hand out at this firmware`, true);
    return;
  }

  // Arming a let-go and then fiddling with weights is not a confirmation.
  ui._wkFire = null;
  ui.net.send('assign-jobs', { workerId: entry.id, jobs });
}
