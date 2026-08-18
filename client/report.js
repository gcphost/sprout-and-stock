/**
 * HOW THE SHOP IS DOING — one picture, not fourteen rows.
 *
 * This panel used to be a list: three tabs of `name · value · caption`, twelve
 * numbers, every one of them the same size and the same weight. That shape is
 * fine for a catalogue, where every row is a thing you might press, and it is
 * wrong for a report, where the whole point is that the numbers are NOT equal —
 * today's profit is the answer and "4 harvested" is a detail, and a list says
 * they are the same. Worse, the three tabs meant the two questions a shopkeeper
 * actually holds together ("am I making money" and "what is going wrong") were
 * one click apart, so you could never see both.
 *
 * So: four blocks, one scroll, no tabs. A hero figure, the week it sits in,
 * what went wrong, and the state of the floor. Nothing is new — every number in
 * here was in the list — what changed is that they are now sized by how much
 * they matter and drawn in the shape of the question they answer.
 *
 * Pure functions handing back HTML, the way `client/hud-meters.js` does, for
 * the same reasons: the caller diffs a signature and writes the result, nothing
 * in here touches the DOM or holds state, and a readout with no lifecycle is
 * one that cannot leak or go stale.
 *
 * **Why divs rather than the inline SVG the HUD meters use.** The corner
 * readouts are a fixed 56px and will never be anything else. This panel is a
 * range — `min(430px, 100vw - 24px)` on a narrow screen, and a 620px two-column
 * split on a wide one — and an SVG that fills a range either distorts
 * (`preserveAspectRatio="none"` stretches the type with the bars) or keeps its
 * aspect and leaves a gap. Percentages and flex are what "as wide as it happens
 * to be" is written in, and the split below is the reason that mattered.
 */

import { money, signed } from './money.js';
import { zeroScale } from './hud-meters.js';
import { REP_CAUSES, netRep } from '../shared/reputation.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The plot, in pixels, above the day labels.
 *
 * A number here rather than a CSS height because the bars are positioned
 * arithmetically off it — the two halves of a floating axis are `zero` and
 * `H - zero`, and a stylesheet cannot do that sum.
 */
const WEEK_H = 62;

/** Cap on how thick a column gets, from `marks-and-anatomy`: never fill the slot. */
const BAR_W = 18;

/**
 * The reputation strip under the week, in pixels.
 *
 * Well under half the profit plot, and that ratio is the reading: the two rows share
 * an x axis and nothing else, so the smaller one has to look like a companion
 * to the chart above rather than a second chart competing with it. It is also
 * enough — the strip answers "which way, and was it a bad one", and the figures
 * that go with it are in the block below.
 */
const REP_H = 24;

/**
 * A reputation move, in percentage points — `+1.8`, `−0.4`.
 *
 * Points rather than the raw 0..1, because reputation is read as a percentage
 * everywhere else in the game (the HUD bar, the milestone that asks for three
 * quarters), and "−0.024" is a number nobody can place against a bar that says
 * 62%. One decimal, which is exactly what the server rounds to on the way out —
 * so there is no third precision anywhere in the chain.
 *
 * The minus is the typographic one, matching `money`.
 */
const pts = (v) => `${v < 0 ? '−' : '+'}${Math.abs(v * 100).toFixed(1)}`;

/** Under a tenth of a point is a move nothing should be told about. */
const FLAT = 0.0005;

/**
 * THE WHOLE PANEL.
 *
 * Returns '' before the first snapshot, which the caller renders as an empty
 * body — there is no honest report to draw about a shop nobody has loaded yet,
 * and a frame of zeroes reads as a shop that has failed rather than as one that
 * has not arrived.
 */
export function reportHtml(ui) {
  const s = ui.state;
  if (!s) return '';
  const st = s.stats ?? {};
  const days = (s.ledger ?? []).map((d) => ({
    day: d.day,
    net: (d.revenue ?? 0) - (d.spent ?? 0),
    // A day filed before the shop kept a reputation ledger has neither, and is
    // drawn as a gap rather than as a flat day — see `repStrip`.
    rep: d.rep, repMove: d.repMove,
  }));

  /**
   * FIVE CELLS IN A GRID, paired across rather than stacked in two columns.
   *
   * The first cut of this was two side-by-side columns, and the reason it did
   * not work is worth keeping: two columns is two *lists*, so the blocks in one
   * had nothing to do with the blocks beside them and every block ended
   * wherever its own content happened to end. What you got was a ragged seam
   * down the middle and a short right column leaving one tall block on the left
   * marooned beside empty panel — the report looked broken in the exact place
   * it was trying to be organised.
   *
   * A grid pairs them instead, and the pairs are the reading: today's money
   * beside today's standing, the week's money beside the state of the floor,
   * and what went wrong across the bottom of both — it belongs to neither
   * column because it is the evidence for both. The row lines run all the way
   * across because the cells are in step, which is the whole difference between
   * a segmented panel and one that has been sawn in half.
   *
   * `pnl-wide` is a request rather than a style: `showPanel` sees it in the
   * content and widens the panel, the same way it decides on three panes by
   * looking for a `.pnl-mid`. Declared by the content because the panel is one
   * element shared by fourteen menus and none of the others wants 620px — a
   * width set by whoever opened it is a width somebody forgets to set back.
   *
   * Under the breakpoint the grid is off and these are five ordinary blocks in
   * DOM order, which is the single column this panel has always been. Nothing
   * re-orders and nothing is hidden — one layout that folds, rather than two
   * that have to be kept saying the same thing.
   */
  return `<div class="rp pnl-wide">
    ${todayBlock(ui, st, days)}
    ${repBlock(s, st)}
    ${weekBlock(days)}
    ${floorBlock(s, st)}
    ${wrongBlock(st)}
  </div>`;
}

/**
 * TODAY — the hero figure, and where the money that made it went.
 *
 * Exactly one hero per view (`marks-and-anatomy`), and profit is it: takings are
 * a number a shop can be proud of while losing money on every sale, which is
 * precisely the mistake a big revenue figure invites. Taken and Spent are still
 * here, one size down, as the two ends of the bar that explains the hero.
 *
 * The hero is COLOURED and that is an exception worth naming. The rule is that
 * text wears text tokens and colour belongs to marks — but this is a status
 * figure, where the colour *is* the reading, and the same green-and-red is
 * already what the corner cashflow readout and every heat pill in the game use.
 * What the rule is really protecting against is colour carrying the message
 * ALONE, and it does not here: the word under it says "profit" or "loss", the
 * value is signed, and the delta carries an arrow. Red/green is the worst pair
 * in existence for a deuteranope — 2.3 ΔE, which is no separation at all — so
 * nothing anywhere in this panel may rest on it, and nothing does.
 */
function todayBlock(ui, st, days) {
  const taken = st.revenue ?? 0;
  const spent = st.spent ?? 0;
  const profit = taken - spent;
  const up = profit >= 0;
  // A day that has not started yet is neither. Painting $0.00 green under the
  // word "profit" is a claim about a day nothing has happened in, and every
  // shop reads it at eight in the morning.
  const tone = !taken && !spent ? 'idle' : up ? 'up' : 'down';
  const yesterday = days.at(-1)?.net;

  // Against **yesterday** rather than against zero, because zero is not the
  // question — a shop taking $400 a day is not doing well because $400 is
  // positive. On day one there is no yesterday and the line is left off
  // altogether, rather than calling the first day of every shop a triumph.
  const delta = yesterday === undefined ? '' : (() => {
    const d = profit - yesterday;
    const dir = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    return `<span class="rp-delta ${dir}" title="yesterday finished on ${money(yesterday)}">
      <i>${{ up: '▲', down: '▼', flat: '·' }[dir]}</i>${signed(d)}
      <em>vs yesterday</em></span>`;
  })();

  const best = Object.entries(st.byItem ?? {}).sort((a, b) => b[1] - a[1])[0];
  const sold = st.sold ?? 0;

  return `<section class="rp-blk rp-today">
    <h4>Today</h4>
    <div class="rp-hero ${tone}">
      <b>${money(profit)}</b>
      <span class="rp-heroside">
        <em>${tone === 'idle' ? 'nothing yet today' : `${up ? 'profit' : 'loss'} so far`}</em>
        ${delta}
      </span>
    </div>
    ${splitBar(taken, spent)}
    <p class="rp-note">${sold
    ? `${sold} unit${sold === 1 ? '' : 's'} over the counter${
      best ? ` · best seller <b>${esc(ui.itemName(best[0]))}</b> ×${best[1]}` : ''}`
    : 'Nothing has gone through a till yet today.'}</p>
  </section>`;
}

/**
 * Where the day's money went, as ONE bar rather than two.
 *
 * Taken and Spent are not two independent magnitudes to compare — one contains
 * the other, and what a shopkeeper wants off this is "of what came in, how much
 * stayed". So it is part-to-whole: the track is the bigger of the two, and the
 * segment that is *left over* is the profit. A losing day inverts it cleanly
 * without a special case in the reading — the track becomes what you spent, the
 * paid-for part is what you took back, and the tail hanging off the end is the
 * hole. Same picture, and the eye learns one thing instead of two.
 *
 * Segments are separated by a 2px gap in the surface colour rather than by a
 * border. A stroke around a fill is ink that is not data; the gap does the same
 * job and weighs nothing.
 */
function splitBar(taken, spent) {
  const total = Math.max(taken, spent);
  if (!total) {
    return `<div class="rp-split empty"><span class="rp-track"></span>
      <p class="rp-legend"><span>Nothing in, nothing out.</span></p></div>`;
  }
  const up = taken >= spent;
  // The shared part is whichever of the two is smaller — the money that came in
  // AND went out again. What is left is the story: kept, or short.
  const shared = Math.min(taken, spent);
  const rest = total - shared;
  const pct = (n) => `${((n / total) * 100).toFixed(2)}%`;

  return `<div class="rp-split">
    <span class="rp-track">
      <i class="rp-seg base" style="flex:0 0 ${pct(shared)}"
        title="${up ? `${money(spent)} spent on stock, seed and building` : `${money(taken)} taken`}"></i>
      ${rest ? `<i class="rp-seg ${up ? 'kept' : 'short'}" style="flex:0 0 ${pct(rest)}"
        title="${up ? `${money(rest)} of the takings stayed` : `${money(rest)} more went out than came in`}"></i>` : ''}
    </span>
    <p class="rp-legend">
      <span><b>${money(taken)}</b> taken</span>
      <span><b>${money(spent)}</b> spent</span>
    </p>
  </div>`;
}

/**
 * THE WEEK — profit per finished day, oldest at the left.
 *
 * Finished days only, which is deliberate and is the same call the corner
 * sparkline makes: today is a part-day, and standing a half-written bar beside
 * six whole ones reads as a slump every single morning. Today is the hero above
 * this; the shape is the days that are done.
 *
 * The sign is carried by DIRECTION — above the line or below it — and the
 * colour merely agrees. That ordering matters: it is what makes the chart legal
 * for a reader who cannot tell the two colours apart at all, and it is why the
 * axis is drawn whenever there is a losing day rather than only when it is
 * convenient.
 *
 * Labelled selectively. A number over every column is chaos and goes unread, so
 * only the best day and the worst get one, plus the average as a reference rule
 * — which is the one row the old list called "Daily average" and could not show
 * you the position of.
 */
function weekBlock(days) {
  if (!days.length) {
    return `<section class="rp-blk">
      <h4>The week</h4>
      <p class="rp-note">No finished days yet. Come back tomorrow morning.</p>
    </section>`;
  }

  const nets = days.map((d) => d.net);
  const { bottom, span, zero } = zeroScale(nets, WEEK_H);
  const mean = nets.reduce((a, b) => a + b, 0) / nets.length;
  const hi = Math.max(...nets);
  const lo = Math.min(...nets);
  // One column marked at each end, and never the same one twice: a week with
  // one finished day, or a flat one, has a best that IS the worst, and two
  // labels stacked on one 18px column is the collision the spec warns about.
  const showLo = lo !== hi;

  const cols = days.map((d) => {
    const h = Math.max(1, (Math.abs(d.net) / span) * WEEK_H);
    const win = d.net >= 0;
    const tag = d.net === hi ? 'hi' : (showLo && d.net === lo) ? 'lo' : '';
    return `<div class="rp-col${tag ? ` ${tag}` : ''}" title="Day ${d.day} — ${money(d.net)}">
      <span class="rp-up" style="height:${zero.toFixed(1)}px">
        ${win ? `<i style="height:${h.toFixed(1)}px"></i>` : ''}</span>
      <span class="rp-dn" style="height:${(WEEK_H - zero).toFixed(1)}px">
        ${win ? '' : `<i style="height:${h.toFixed(1)}px"></i>`}</span>
      ${tag ? `<em class="rp-pin ${win ? 'over' : 'under'}"
        style="${win ? 'bottom' : 'top'}:${(win ? WEEK_H - zero + h : zero + h).toFixed(1)}px"
        >${money(d.net)}</em>` : ''}
      <b>${d.day}</b>
    </div>`;
  }).join('');

  // Solid hairlines, both of them. Dashing reads as "projection" and these are
  // neither — one is zero, which is a fact, and the other is the average, which
  // is arithmetic on the bars you can see.
  const axis = bottom < 0
    ? `<span class="rp-axis" style="top:${zero.toFixed(1)}px"></span>` : '';
  // Unlabelled on purpose — see the note on `.rp-avg`. The number is in the
  // heading, where it cannot land on a bar or fight the best day's own label.
  const avg = `<span class="rp-avg" title="the average of these ${days.length} days"
    style="top:${(zero - (mean / span) * WEEK_H).toFixed(1)}px"></span>`;

  return `<section class="rp-blk">
    <h4>The week <small>${days.length} finished day${days.length === 1 ? '' : 's'} · avg ${money(mean)}</small></h4>
    <div class="rp-week" style="--plot:${WEEK_H}px">
      <div class="rp-plot">${axis}${avg}${cols}</div>
      ${repStrip(days)}
    </div>
  </section>`;
}

/**
 * ...and the same week, in the other currency the shop keeps.
 *
 * A SECOND ROW rather than a line over the bars, and that is the one decision
 * in here. Money and reputation share nothing but the calendar — one is dollars
 * with no ceiling, the other is a share of one that saturates — so drawing them
 * on one set of axes means two scales down one edge, where every reading is
 * "which line am I on" before it is anything about the shop. Sharing the *x* and
 * nothing else costs a strip of 20px and asks the eye to do the thing it is
 * good at instead: line the two up and see that the losing days are the days the
 * shop's name went with them. Which is exactly the question — a day can lose
 * money because you bought a freezer, and that is not the same day as one where
 * forty people walked out.
 *
 * It has its own zero and its own scale, from the same `zeroScale` the profit
 * plot and the corner sparkline use, so a week of small moves fills the strip
 * rather than reading as a flat line — the shape is the point, the size is in
 * the block below and in the tooltip.
 *
 * Drawn only once there is something to draw. Every day filed before the shop
 * kept this ledger has no `repMove` at all, and a missing number is NOT a zero:
 * a row of flat bars across the days before the feature existed is a claim that
 * nothing happened on them, which is a lie the panel would tell for a week
 * after any update. Those days get a gap.
 */
function repStrip(days) {
  const known = days.filter((d) => typeof d.repMove === 'number');
  if (!known.length) return '';

  const { bottom, span, zero } = zeroScale(known.map((d) => d.repMove), REP_H);
  const cols = days.map((d) => {
    const v = d.repMove;
    if (typeof v !== 'number') {
      return `<div class="rp-rcol" title="Day ${d.day} — not recorded"></div>`;
    }
    const win = v >= 0;
    const h = Math.max(1, (Math.abs(v) / span) * REP_H);
    const move = Math.abs(v) < FLAT ? 'held steady' : `${pts(v)} points`;
    return `<div class="rp-rcol" title="Day ${d.day} — reputation ${move}${
      typeof d.rep === 'number' ? `, finished on ${(d.rep * 100).toFixed(0)}%` : ''}">
      <span class="rp-rup" style="height:${zero.toFixed(1)}px">
        ${win ? `<i style="height:${h.toFixed(1)}px"></i>` : ''}</span>
      <span class="rp-rdn" style="height:${(REP_H - zero).toFixed(1)}px">
        ${win ? '' : `<i style="height:${h.toFixed(1)}px"></i>`}</span>
    </div>`;
  }).join('');

  // The zero rule, on the same terms the plot above draws its own: only when
  // something is under it, or a line along the bottom edge reads as a threshold
  // somebody picked rather than as nothing.
  const axis = bottom < 0
    ? `<span class="rp-raxis" style="top:${zero.toFixed(1)}px"></span>` : '';

  return `<div class="rp-strip">
    <span class="rp-shead">Reputation, points a day</span>
    <div class="rp-rep" style="--rep:${REP_H}px">${axis}${cols}</div>
  </div>`;
}

/**
 * GOING WRONG — three tiles, and a shop that is fine says so.
 *
 * Status colour, which is reserved and never used for anything that is merely a
 * quantity: a tile lights only when its number is above zero, and it ships with
 * its label either way. Three greyed-out zeroes is a worse reading than one
 * sentence, because a row of zeroes still looks like a report of problems until
 * you have read all three — hence the all-clear line.
 *
 * `Binned` leads on the VALUE and captions the count, which is the way round the
 * old list eventually landed on and the reason is worth keeping: a shop binning
 * 47 units has no idea whether that mattered, and a shop binning $61.40 knows
 * immediately, because it is the same unit as the hero at the top of the panel.
 */
function wrongBlock(st) {
  const out = st.abandoned ?? 0;
  const empty = st.leftEmpty ?? 0;
  const binned = st.spoiled ?? 0;
  const binnedValue = st.spoiledValue ?? 0;

  if (!out && !empty && !binned) {
    return `<section class="rp-blk rp-full">
      <h4>Going wrong</h4>
      <p class="rp-clear">Nothing today. Nobody walked out, nothing went in the bin.</p>
    </section>`;
  }

  const tile = (v, on, name, sub, sev) => `<div class="rp-tile${on ? ` ${sev}` : ''}">
    <b>${v}</b><span class="rp-tname">${name}</span><span class="rp-tsub">${sub}</span></div>`;

  return `<section class="rp-blk rp-full">
    <h4>Going wrong</h4>
    <div class="rp-tiles">
      ${tile(out, out, 'Walked out', 'queued too long, or could not find it', 'bad')}
      ${tile(empty, empty, 'Found nothing', 'came in, the shelf was bare', 'bad')}
      ${tile(money(binnedValue), binned, 'Binned',
    `${binned} unit${binned === 1 ? '' : 's'} past their shelf life`, 'warn')}
    </div>
  </section>`;
}

/**
 * REPUTATION — where it stands, and what moved it today.
 *
 * Called reputation everywhere a player can see, because that is what the HUD
 * bar, the milestone ladder and the supplier already call it. One number wearing
 * two names in the same shop is two numbers as far as anybody reading it is
 * concerned.
 *
 * The block this panel was missing, and the reason is worth writing down: the
 * HUD has shown reputation as a bar since the shop opened, so "how am I doing"
 * was always answered and *"what is costing me"* never was. Those are not the
 * same question and only the second one can be acted on — a bar sliding left
 * over a week tells a player something is wrong and gives them seven mechanics
 * to guess between, which in practice reads as the number moving on its own.
 *
 * So: one figure for where you stand, one for the day's movement, and then the
 * causes, which are the whole point. Every row is a thing that happened in the
 * shop today with the price of it beside it — and they are drawn against a
 * shared centre, so the gains and the losses are on opposite sides of one line
 * and "who is winning" is a glance rather than an addition.
 *
 * Ordered by CAUSE and not by size (see `shared/reputation.js`). A list that
 * re-sorts itself as you watch has to be re-read every time you look at it, and
 * the bars already say which is biggest.
 *
 * It sits under `Going wrong` on purpose. Those tiles count the incidents; this
 * says what they cost — a shop with one walk-out and an hour of being packed
 * has two small numbers up there and one clear answer down here.
 *
 * Spoilage is deliberately absent, because it does not move reputation: rot
 * costs money, it is already the `Binned` tile, and nobody who walked in today
 * ever saw it. A row here for something that is always zero would be a claim
 * that the shop is being judged on it.
 */
function repBlock(s, st) {
  const level = s.reputation ?? 0;
  const moves = st.repMoves ?? {};
  const net = netRep(moves);
  const dir = net > FLAT ? 'up' : net < -FLAT ? 'down' : 'flat';

  const rows = REP_CAUSES
    .map((c) => ({ ...c, v: moves[c.id] ?? 0 }))
    .filter((r) => Math.abs(r.v) >= FLAT);
  // The longest bar is the biggest mover, whichever way it went — one scale for
  // both sides of the axis, or a shop that gained 4 points and lost 0.2 draws
  // them the same length and the picture says the opposite of the numbers.
  const scale = Math.max(...rows.map((r) => Math.abs(r.v)), FLAT);

  const body = rows.length
    ? `<div class="rp-causes">${rows.map((r) => {
      const win = r.v > 0;
      const w = (Math.abs(r.v) / scale) * 50;
      return `<div class="rp-cause" title="${esc(r.sub)}">
        <span class="rp-cname">${esc(r.name)}</span>
        <span class="rp-cval ${win ? 'up' : 'down'}">${pts(r.v)}</span>
        <span class="rp-ctrack"><i class="${win ? 'up' : 'dn'}"
          style="${win ? 'left' : 'right'}:50%;width:${w.toFixed(1)}%"></i></span>
      </div>`;
    }).join('')}</div>`
    : `<p class="rp-clear">Nothing has moved your reputation today — nobody has
       been served, annoyed or turned away yet.</p>`;

  return `<section class="rp-blk">
    <h4>Reputation</h4>
    <div class="rp-rnow">
      <b>${Math.round(level * 100)}%</b>
      <span class="rp-delta ${dir}">
        <i>${{ up: '▲', down: '▼', flat: '·' }[dir]}</i>${dir === 'flat' ? 'level' : pts(net)}
        <em>${dir === 'flat' ? 'today' : 'points today'}</em></span>
    </div>
    ${body}
  </section>`;
}

/**
 * THE SHOP — two meters and a line of facts.
 *
 * Shelves and plots are both a ratio against a limit, which is a meter rather
 * than a chart of two numbers. Queueing and harvested are neither — they are
 * counts with no ceiling to be a share of — so they are a sentence, which is
 * what the form heuristic says to do with a number that is not a shape.
 */
function floorBlock(s, st) {
  const shelves = s.shelves ?? [];
  const plots = s.plots ?? [];
  const queues = s.queues ?? [];
  const held = shelves.filter((x) => (x.stacks ?? []).some((k) => k.qty > 0)).length;
  const planted = plots.filter((p) => p.crop_id).length;
  const ready = plots.filter((p) => p.ready).length;
  const waiting = queues.reduce((a, q) => a + q.queue, 0);

  return `<section class="rp-blk">
    <h4>The shop</h4>
    ${meter('Shelves holding something', held, shelves.length, `${held} of ${shelves.length}`)}
    ${meter('Beds planted', planted, plots.length,
    `${planted} of ${plots.length}${ready ? ` · ${ready} ready` : ''}`)}
    <p class="rp-note">${waiting} queueing across ${queues.length} till${
  queues.length === 1 ? '' : 's'} · ${st.harvested ?? 0} picked today</p>
  </section>`;
}

/**
 * A ratio against a limit.
 *
 * The unfilled track is a lighter step of the fill rather than a neutral grey,
 * so the state reads across the whole bar instead of only across the part that
 * is full. A shop with no shelves at all draws an empty track and says 0 of 0
 * rather than dividing by zero.
 */
function meter(name, have, of, right) {
  const pct = of > 0 ? Math.max(0, Math.min(1, have / of)) : 0;
  return `<div class="rp-meter">
    <span class="rp-mname">${name}</span>
    <span class="rp-mval">${right}</span>
    <span class="rp-mtrack"><i style="width:${(pct * 100).toFixed(1)}%"></i></span>
  </div>`;
}
