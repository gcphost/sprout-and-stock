/**
 * THE AWARD CARD — the one thing in the game that stops to congratulate you.
 *
 * A milestone is announced three times over, and this is the loud one: the log
 * gets a line, the Milestones panel gets a tick, and this takes the screen.
 * That is deliberate — the whole complaint the ladder answers is that a shop
 * doing well and a shop doing nothing look identical, and a toast in the corner
 * would be a fourth thing sliding past you while you stock a shelf.
 *
 * Three things about it are load-bearing:
 *
 * **It stops the world.** `pause` is world-wide (`Game.setPaused`), so the shop
 * holds still while you read — nobody walks out of a queue over an award. It
 * puts the clock back exactly as it found it: a card that unpaused on its way
 * out would restart a shop you had deliberately stopped, so `restore` is the
 * state read off the snapshot at the moment the card went up, not `false`.
 *
 * **It queues.** Two milestones can land in one tick — the sim awards them in
 * the same sweep — and two cards on top of each other is one card you never
 * see. They are shown one at a time with a count of what is still to come.
 *
 * **The medal hangs off the top.** It is `position: absolute` above the card
 * rather than inside it, over a band of gold and a sunburst that turns. That is
 * the whole visual argument: everything else in this HUD is a cream panel with
 * a header, and an award that looked like the supplier would read as another
 * menu opening.
 */

import { ICONS } from './icons.js';

const money = (n) => `$${Number(n).toFixed(2)}`;

export class Award {
  constructor(ui, el) {
    this.ui = ui;
    this.el = el;
    this.queue = [];
    this.showing = null;
    // Whether the clock was already stopped when the first card went up. Held
    // across the whole run of them: pausing per card would hand the world back
    // between two awards that arrived together.
    this.restore = false;
    this.render();
  }

  render() {
    this.el.innerHTML = `
      <div class="award-back"></div>
      <div class="award-card">
        <div class="award-rays"></div>
        <div class="award-medal">${ICONS.medal}</div>
        <div class="award-kicker">Milestone</div>
        <h2 class="award-name"></h2>
        <p class="award-blurb"></p>
        <ul class="award-got"></ul>
        <div class="award-town"></div>
        <button class="award-go" type="button">Nice</button>
        <div class="award-more"></div>
      </div>`;
    this.card = this.el.querySelector('.award-card');
    this.el.querySelector('.award-go').onclick = () => this.dismiss();
    // The backdrop dismisses too, but the card itself must not — a click that
    // lands on the medal while you are reading would close the thing you are
    // reading.
    this.el.querySelector('.award-back').onclick = () => this.dismiss();
  }

  get open() { return this.showing !== null; }

  /** One announcement off the wire. */
  push(won) {
    this.queue.push(won);
    if (!this.open) this.next();
  }

  next() {
    const won = this.queue.shift() ?? null;
    this.showing = won;
    if (!won) { this.close(); return; }

    if (!this.el.classList.contains('show')) {
      // Asked once, for the whole run. `state.paused` is the shop's own answer,
      // so a card that goes up over an already-stopped clock leaves it stopped.
      this.restore = this.ui.state?.paused === true;
      if (!this.restore) this.ui.setPaused(true);
    }

    this.el.querySelector('.award-name').textContent = won.name;
    this.el.querySelector('.award-blurb').textContent = won.blurb;
    this.el.querySelector('.award-got').innerHTML = rewardHtml(won);
    // The town, on every card rather than only the ones that grew it — this
    // number has never been on screen anywhere else, and a line that appeared
    // only when it moved would be a number with no scale to read it against.
    this.el.querySelector('.award-town').innerHTML = won.catchment
      ? `<b>${Math.round(won.catchment)}</b><span>people within reach of the shop</span>`
      : '';
    this.el.querySelector('.award-more').textContent = this.queue.length
      ? `${this.queue.length} more to come`
      : '';

    this.el.hidden = false;
    // Restart the pop, or a second card in the same run would slide in with no
    // animation at all — the element never left the document, so the keyframe
    // has already played.
    this.card.style.animation = 'none';
    void this.card.offsetWidth;
    this.card.style.animation = '';
    this.el.classList.add('show');
  }

  /** The button, the backdrop, Esc, or Enter. */
  dismiss() {
    if (!this.open) return;
    if (this.queue.length) { this.next(); return; }
    this.showing = null;
    this.close();
  }

  close() {
    this.el.classList.remove('show');
    this.el.hidden = true;
    this.showing = null;
    if (!this.restore) this.ui.setPaused(false);
  }
}

/**
 * What you got, as rows.
 *
 * Read off `reward` rather than off the sentence the server already wrote
 * (`won.got`), because the two are for different places: the log wants one line
 * of prose and this wants three things you can see at a glance. The one
 * exception is stock — what the van is actually bringing is chosen by the shop
 * and only the server knows what it picked, so that row prints what it said.
 */
function rewardHtml(won) {
  const r = won.reward ?? {};
  const rows = [];
  if (r.cash > 0) rows.push(['💰', money(r.cash), 'straight into the till']);
  if (r.town > 0) {
    rows.push(['🏘️', `+${r.town} in reach`, 'more of the town walks past']);
  }
  if (r.supplies > 0) {
    // What actually got sent, if it did. A bay with no room takes the gift and
    // the card must not promise crates that are never coming.
    const sent = (won.got ?? []).find((g) => g.includes('free'));
    rows.push(['📦', sent ? sent.replace(', free', '') : `${r.supplies} units of stock`,
      sent ? 'free, on the next van' : 'nowhere at the bay to land it']);
  }
  return rows.map(([ico, big, sub]) => `<li>
      <span class="aico">${ico}</span>
      <span class="atext"><b>${big}</b><i>${sub}</i></span>
    </li>`).join('');
}
