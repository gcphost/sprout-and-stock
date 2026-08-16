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
import { act } from './fixture-menu.js';

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

  parts.push('<div class="sep">What they do</div>');
  parts.push(vocabulary.map((j) => jobRow(j, weights.get(j) ?? 0)).join(''));
  // With the rows it explains, rather than in the pinned foot: it is read once,
  // and two lines of standing prose is a third of what the foot has room for.
  parts.push('<div class="foot">A weight is how much of their day a job gets. '
    + 'Nothing means never — and everyone needs at least one.</div>');

  const foot = [];

  const next = nextTier(kind, entry.tier);
  if (next) {
    const afford = (ui.state?.cash ?? 0) >= next.cost;
    // The rung's name is authored and can be any length, so it goes in the
    // wrapping description rather than the one-line title — the same call the
    // fixture menu makes, for the same reason. The title is the verb, which is
    // short and fixed; the line under it says what you are actually buying.
    const blurb = `${esc(next.name)} — ${tierBlurb(next)}`;
    foot.push(act('promote', ICONS.tierup, 'Promote',
      afford ? blurb : `${blurb} You cannot afford it yet.`,
      // A purely cosmetic rung is free, and `$0` reads as a broken number.
      { off: !afford, right: next.cost > 0 ? `$${next.cost.toFixed(0)}` : 'free' }));
  }

  const armed = armedToFire(ui, entry.id);
  foot.push(act('fire', ICONS.remove,
    armed ? 'Tap again to let them go' : 'Let them go',
    armed ? 'They walk out now, and nothing comes back.' : 'No refund — you cannot sell a person back.',
    { danger: true }));

  parts.push(`<div class="pnl-foot">${foot.join('')}</div>`);

  ui.showPanel(`${icon(entry.kind, ICONS.staff)} ${esc(entry.name)}`, parts.join(''));
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
    ui.state?.cash?.toFixed(0), ui.catalog.version, armedToFire(ui, entry.id)]);
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
    ${kind?.wage > 0 ? line('Wage', `$${kind.wage.toFixed(2)} a day`) : ''}
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

/** The next rung up, or null when they are already at the top of the ladder. */
function nextTier(kind, tier) {
  const tiers = kind?.tiers ?? [];
  const at = Math.min(Math.max(1, Math.trunc(tier ?? 1)), Math.max(1, tiers.length));
  const next = tiers[at];
  return next ? { ...next, tier: at + 1 } : null;
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

function wireWorkerMenu(ui, entry, weights, vocabulary) {
  ui.el.panelBody.querySelectorAll('[data-step]').forEach((el) => {
    el.onclick = () => setWeight(ui, entry, weights, vocabulary, el.dataset.job, Number(el.dataset.step));
  });

  ui.el.panelBody.querySelectorAll('[data-act]').forEach((el) => {
    el.onclick = () => {
      if (el.dataset.act === 'promote') {
        ui.net.send('promote', { workerId: entry.id });
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
