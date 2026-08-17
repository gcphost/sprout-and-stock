/**
 * One menu per hire.
 *
 * Tapping a name on the roster opens that person, exactly the way tapping a
 * shelf opens that shelf — and for the same reason. Two stockers are two
 * people, and the only thing that can tell them apart is which row you pressed.
 *
 * Everything on this screen is *theirs*, not their kind's: the job list was
 * copied off the kind the day they were taken on, and from then on it is a row
 * in the roster that only this menu writes to.
 *
 * Functions take `ui` first rather than living on it, like `fixture-menu.js` —
 * this reads the snapshot and sends messages, it isn't part of the HUD's state.
 */

import { ICONS, icon } from './icons.js';
import { actIcon } from './fixture-menu.js';
// One sell-back rate for the whole shop, not one per ladder: a rung handed back
// is worth what a fixture torn out is worth, and two copies of that number would
// be two different amounts of money — which is the argument the constant itself
// makes about the button printing it and the server paying it.
import { FIXTURE_REFUND } from '../shared/build.js';
// A swatch is drawn from the kind's own art, so this menu resolves a model the
// same way the renderer does rather than keeping a second idea of one.
import { partsAt } from '../shared/model.js';

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
 */
const JOB_INFO = {
  serve: { name: 'Serve', doing: 'on the till', blurb: 'Take money at a till.' },
  restock: { name: 'Restock', doing: 'ordering stock', blurb: 'Order in for a bare shelf.' },
  unload: { name: 'Unload', doing: 'unloading a pallet', blurb: 'Bring pallets in off the bay.' },
  shelve: { name: 'Shelve', doing: 'filling a shelf', blurb: 'Put what they hold on a shelf.' },
  till: { name: 'Till', doing: 'turning the soil', blurb: 'Turn rough ground over.' },
  sow: { name: 'Sow', doing: 'sowing', blurb: 'Plant a turned bed.' },
  harvest: { name: 'Harvest', doing: 'harvesting', blurb: 'Pick whatever is ripe.' },
  craft: { name: 'Craft', doing: 'working the appliances', blurb: 'Work the appliances.' },
  tidy: { name: 'Tidy', doing: 'tidying up', blurb: 'Crate what has nowhere to go.' },
  // NOT "Shop hand" — that is the name of a worker *kind* (`shop-hand`), and a
  // job sharing it would read as the one job that worker does.
  merchandise: {
    name: 'Merchandise',
    doing: 'working the shelves',
    blurb: 'Clear boards nothing sells off, and merge split ones.',
  },
};

/** Highest weight the stepper will climb to. Authored lists sit at 1–10. */
const WEIGHT_MAX = 10;

/**
 * How long "tap again to let them go" stays armed.
 *
 * Removing a shelf hands half the money back and you can build another one.
 * Letting someone go refunds nothing, so a mis-tap in a scrolling list costs a
 * whole hire — which is the one place in this UI worth asking twice.
 */
const FIRE_ARM_MS = 4000;

const titleCase = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const infoFor = (job) => JOB_INFO[job] ?? { name: titleCase(job), doing: String(job), blurb: '' };
const mult = (n) => `${Number(n) % 1 === 0 ? n : Number(n).toFixed(1)}×`;

/** The roster row for one hire — the record, not the body walking about. */
export const rosterEntry = (ui, id) => (ui.state?.roster ?? []).find((e) => e.id === id) ?? null;

/** The NPC on the floor, or null if their kind was deleted out from under them. */
export const bodyOf = (ui, entry) => (ui.state?.players ?? [])
  .find((p) => p.hire === entry.id) ?? null;

/** What a hire is doing right now. Read by the roster list and by their menu. */
export function doingNow(ui, entry, body) {
  if (!body) return 'not turned up — their kind was deleted';
  // A break outranks what is in their hands: "carrying 4× tomato" while they
  // are sat outside vaping is the wrong half of the truth.
  if (body.job === 'break') return onBreakNow(ui, body);
  if (body.carry) return `carrying ${body.carry.qty}× ${ui.itemName(body.carry.item_id)}`;
  return body.job ? infoFor(body.job).doing : 'looking for something to do';
}

/** The authored line for the break they are on, or that they are off to take one. */
function onBreakNow(ui, body) {
  const p = (ui.catalog.pastimes ?? []).find((x) => x.id === body.pastime);
  return p ? p.doing : 'off for a break';
}

/** Worn out enough that the menu should say so rather than just show a bar. */
const SPENT = 0.25;

/** "$4 a day · serve, unload, shelve" — enough to choose by, in one clause. */
export function kindSummary(kind) {
  const jobs = (kind.jobs ?? []).map((j) => infoFor(j.job).name.toLowerCase()).join(', ');
  return kind.wage > 0 ? `${money(kind.wage)} a day · ${jobs}` : jobs;
}

/**
 * Wages are authored, so they are not whole numbers. Rounding $3.50 to "$4"
 * over-states what a hire costs by a seventh, which is the same lie as a
 * button promising a different price to the one it charges.
 */
const money = (n) => `$${Number(n) % 1 === 0 ? n : Number(n).toFixed(2)}`;

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

  ui.openPanel = 'worker';
  // Like a fixture's menu, this isn't a section, so nothing on the rail is lit.
  ui.rail.setOpen(null);
  ui.workerRef = workerId;
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
  const parts = [`<div class="pnl-head">${detail(ui, entry, kind, body)}</div>`];

  // The scrolling half, tabbed by the same rule the fixture menu uses: two or
  // more groups earns tabs, one does not. What they do and what they look like
  // are both long and neither ever wants the other on screen — a job list you
  // scroll past to reach the skins is the shape that made the fixture menu grow
  // tabs in the first place.
  const groups = [
    {
      label: 'What they do',
      icon: ICONS.staff,
      html: vocabulary.map((j) => jobRow(j, weights.get(j) ?? 0)).join('')
        // With the rows it explains, rather than in the pinned foot: it is read
        // once, and two lines of standing prose is more than the foot now has.
        + '<div class="foot">A weight is how much of their day a job gets. '
        + 'Nothing means never — and everyone needs at least one.</div>',
    },
  ];

  // A look is free and changes no number, so it is a browse rather than a
  // decision — the same call `styleRows` makes about a fixture's shape. A shop
  // where nobody has authored a skin gets no tab at all, rather than a tab
  // holding one row that says "as built".
  const skins = skinRows(ui, entry);
  if (skins.length > 1) {
    groups.push({ label: 'Look', icon: ICONS.floor, rows: skins });
  }

  const at = Math.min(ui._wkTab ?? 0, groups.length - 1);
  // Tabs sit OUTSIDE the scroller — they choose what it holds, so scrolling
  // them away would leave you in a list with no way back to the other one.
  if (groups.length > 1) {
    parts.push(`<div class="tabs">${groups.map((g, n) => `
      <button class="tab${n === at ? ' on' : ''}" data-wktab="${n}" title="${esc(g.label)}"
        aria-label="${esc(g.label)}">${g.icon}</button>`).join('')}</div>`);
  }

  // The one pane that scrolls. A real element rather than whatever is left
  // between two sticky ones, so the scrollbar belongs to the list instead
  // of running the whole height of the panel behind the pinned regions.
  const open = groups[at];
  // Named above its rows even with the tabs up, because an icon row is a shape
  // you learn and a heading is a thing you read.
  parts.push(`<div class="pnl-mid"><div class="sep">${esc(open.label)}</div>`
    + (open.html ?? open.rows.map((r, i) => ui.rowHtml(r, i)).join(''))
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

  const next = nextTier(kind, entry.tier);
  if (next) {
    const afford = (ui.state?.cash ?? 0) >= next.cost;
    // The rung's name is authored and can be any length, so it goes in the
    // wrapping description rather than the one-line title — the same call the
    // fixture menu makes, for the same reason. The title is the verb, which is
    // short and fixed; the line under it says what you are actually buying.
    const blurb = `${esc(next.name)} — ${tierBlurb(next)}`;
    foot.push(actIcon('promote', ICONS.tierup, 'Promote',
      afford ? blurb : `${blurb} You cannot afford it yet.`, 'Promote',
      // A purely cosmetic rung is free, and `$0` reads as a broken number.
      { off: !afford, right: next.cost > 0 ? `$${next.cost.toFixed(0)}` : 'free' }));
  }

  // The way back down, and the only rung on any ladder where going down has an
  // ongoing argument for it: a grade is charged every day in wages, so this is
  // a decision rather than an undo. Nothing shows on somebody who was never
  // promoted — the row appears when there is a rung under them.
  const back = prevTier(kind, entry.tier);
  if (back) {
    const saving = back.saves > 0 ? ` Saves ${money(back.saves)} a day in wages.` : '';
    foot.push(actIcon('demote', ICONS.tierdown, 'Demote',
      `Back to ${esc(back.name)} — ${tierBlurb(back)}${saving} Half of that grade back.`,
      'Demote', { right: back.refund > 0 ? `+$${back.refund.toFixed(0)}` : '' }));
  }

  // The latch has to be visible in a square, and it used to be visible in the
  // row's own title — "Tap again to let them go" is a sentence, and a sentence
  // is what a caption is not. So the caption becomes the question and the
  // square lights up: `armed` is the one state here you must not be able to
  // walk past, because the next tap is a person leaving and nothing comes back.
  const armed = armedToFire(ui, entry.id);
  foot.push(actIcon('fire', ICONS.remove,
    armed ? 'Tap again to let them go' : 'Let them go',
    armed ? 'They walk out now, and nothing comes back.' : 'No refund — you cannot sell a person back.',
    armed ? 'Sure?' : 'Let go',
    { danger: true, armed }));

  parts.push(`<div class="pnl-foot"><div class="fx-verbs">${foot.join('')}</div></div>`);

  // Who, and which tab of them. Nudging a weight or picking a skin redraws the
  // whole menu and must keep your place; changing tab or opening someone else
  // is a different list and must not.
  ui.showPanel(`${icon(entry.kind, ICONS.staff)} ${esc(entry.name)}`, parts.join(''),
    `worker:${entry.id}:${at}`);
  wireWorkerMenu(ui, entry, weights, vocabulary, open.rows ?? []);
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
    ui.follow === entry.id]);
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

/** The read-out at the top: who this is and what they are doing about it. */
function detail(ui, entry, kind, body) {
  const line = (label, value) => `<div class="fx-line"><span>${label}</span><b>${value}</b></div>`;
  const tiers = kind?.tiers?.length ? kind.tiers : null;
  const rung = tiers?.[Math.min(Math.max(1, entry.tier ?? 1), tiers.length) - 1] ?? null;
  return `<div class="fx-detail">
    ${line('Doing', esc(doingNow(ui, entry, body)))}
    ${energyLine(body)}
    ${line('Taken on as', esc(kind?.name ?? entry.kind))}
    ${rung ? line('Grade', esc(rung.name)) : ''}
    ${kind?.wage > 0 ? line('Wage', `$${wageAt(kind, entry.tier).toFixed(2)} a day`) : ''}
  </div>`;
}

/**
 * How much is left in the tank, as a bar and a word.
 *
 * A bar on its own says a number; the word says what it *means* for them, which
 * is the thing you would otherwise have to learn by watching someone slow down
 * and wander off. A worker stopping for reasons the player cannot see reads as
 * the same bug this whole section came out of.
 */
function energyLine(body) {
  if (body?.energy == null) return '';
  const e = Math.max(0, Math.min(1, body.energy));
  const word = e > 0.66 ? 'fresh' : e > SPENT ? 'flagging' : 'worn out';
  return `<div class="fx-line"><span>Energy</span>
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
 * Its own row rather than `ui.rowHtml`, for the same reason `act` in the
 * fixture menu is: that shape carries at most one button, and a stepper is
 * three controls. The classes are the shared ones, so it still matches.
 */
function jobRow(job, weight) {
  const info = infoFor(job);
  const off = weight <= 0;
  return `<div class="row wk-job${off ? ' owned' : ''}" title="${esc(info.blurb)}">
    <div class="name">${esc(info.name)}<span class="tags">${esc(info.blurb)}</span></div>
    <div class="fx-price wk-w">
      <button data-job="${esc(job)}" data-step="-1" aria-label="less">−</button>
      <b>${off ? '·' : weight}</b>
      <button data-job="${esc(job)}" data-step="1" aria-label="more">+</button>
    </div>
  </div>`;
}

/**
 * The tint slots, in the order a swatch reads them. One spelling, shared by the
 * swatch and the fallback merge below — `shared/schemas.js` owns the vocabulary
 * and this is the client's single copy of the order to draw them in.
 */
const SLOTS = ['chassis', 'trim', 'glow'];

/** Only ever paint with something the schema would have accepted. */
const isHex = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

/**
 * What this kind was drawn in — the colour each slot has when nothing is worn.
 *
 * Read off the art rather than kept as a second list, the same argument
 * `surfacesAt` makes about shelf boards: the model already says what colour its
 * chassis is, and a swatch that held its own copy would quietly disagree with
 * the bot the day somebody redrew it over MCP.
 */
function authoredSlots(kind) {
  const parts = partsAt(kind?.model, 0);
  const out = {};
  for (const s of SLOTS) out[s] = parts.find((p) => p.tint === s)?.color ?? null;
  return out;
}

/**
 * A skin as a picture, out of the skin's own colours.
 *
 * Three bars rather than a drawn robot, and that is a deliberate stop short of
 * `thumb.js`: what tells two skins apart IS the palette, so the palette is the
 * honest picture. What it must not do is hold colours of its own — hence the
 * merge with what the kind was authored in, so a skin that sets only `glow`
 * swatches the two colours it is actually leaving alone rather than blanks.
 */
function skinSwatch(slots) {
  const cols = SLOTS.map((s) => slots?.[s]).filter(isHex);
  if (!cols.length) return ICONS.staff;
  const w = 16 / cols.length;
  return `<svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">${cols.map((c, i) => `<rect x="${(i * w).toFixed(2)}" y="2" width="${w.toFixed(2)}" height="12" fill="${c}"/>`).join('')}</svg>`;
}

/**
 * Every look this person could have on, as pickable rows.
 *
 * "As built" is a real row with a null id rather than a special case, the same
 * shape `variantsOf` gives a fixture's Standard — it is how you get back out of
 * a skin without there having to be a "default" row somebody could delete.
 *
 * Nothing here is priced, and that is the point rather than an omission: a skin
 * moves no number, so there is no affordability to check and no confirmation to
 * ask for. Compare the foot of this menu, where both are the whole story.
 */
function skinRows(ui, entry) {
  const here = entry.skin ?? null;
  const base = authoredSlots(kindOf(ui, entry));
  const all = [{ id: null, name: 'As built', slots: null }, ...(ui.catalog.skins ?? [])];
  return all.map((s) => ({
    // Merged, not the skin's own slots: an unset slot keeps the authored colour
    // when the renderer draws it, so the swatch has to say the same thing.
    icon: skinSwatch({ ...base, ...(s.slots ?? {}) }),
    name: esc(s.name),
    sub: s.id === here ? 'what they have on'
      : s.id === null ? 'back to the colours their kind was drawn in'
        : extrasBlurb(s),
    picked: s.id === here,
    // A look is free and instant, so the row IS the action — no button, no
    // arming, nothing to undo it but picking another one.
    run: s.id === here ? null : () => ui.net.send('set-skin', { workerId: entry.id, skin: s.id }),
  }));
}

/** Say what a skin brings beyond paint, since a bolted-on part is the one thing about it you cannot read off the swatch. */
function extrasBlurb(skin) {
  const n = skin.extras?.length ?? 0;
  return n ? `free — repaints them, and adds ${n === 1 ? 'a piece' : `${n} pieces`}` : 'free — repaints them head to toe';
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

/** Say what a promotion actually buys, out of its own numbers. */
function tierBlurb(tier) {
  const gains = [];
  if ((tier.speed_mult ?? 1) !== 1) gains.push(`walks ${mult(tier.speed_mult)} as fast`);
  if ((tier.pace_mult ?? 1) !== 1) gains.push(`starts the next job ${mult(tier.pace_mult)} as quick`);
  if ((tier.carry_mult ?? 1) !== 1) gains.push(`carries ${mult(tier.carry_mult)} as much`);
  return gains.length ? `${gains.join(', ')}.` : 'No change to any number — just a better hat.';
}

/** Is the let-go row armed for this person, and has that not timed out? */
function armedToFire(ui, id) {
  const arm = ui._wkFire;
  if (!arm || arm.id !== id) return false;
  if (performance.now() - arm.at > FIRE_ARM_MS) { ui._wkFire = null; return false; }
  return true;
}

function wireWorkerMenu(ui, entry, weights, vocabulary, rows) {
  // Which tab is showing belongs to the MENU rather than to the person, the
  // same call the fixture menu makes: opening two hires in a row to compare
  // their weights should not put you back on Look every time.
  ui.el.panelBody.querySelectorAll('[data-wktab]').forEach((el) => {
    el.onclick = () => { ui._wkTab = Number(el.dataset.wktab); showWorker(ui, entry.id); };
  });

  // The Look tab's rows are ordinary picker rows, so they wire the ordinary
  // way. The job rows are not — a stepper is three controls and `rowHtml`
  // carries one button — which is why they keep their own template below.
  ui.wireRows(rows);

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

  // Arming a let-go and then fiddling with weights is not a confirmation.
  ui._wkFire = null;
  ui.net.send('assign-jobs', { workerId: entry.id, jobs });
}
