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
import { money } from './money.js';
import { SUPPORT_URL, SUPPORT_LABEL, awardSupport } from './links.js';
import { opensAt } from '../shared/reveal.js';

export class Award {
  /**
   * `takeInput` is what to do to a gesture that is already in flight — see
   * `dropGesture` in client/main.js, and the note on the backdrop below for why
   * a card is the one overlay in the game that needs it.
   *
   * Handed in rather than reached for, because everything a card does to the
   * world it does through `ui` (`setPaused`), and the pointer is not `ui`'s —
   * it belongs to the canvas, which is main.js's. A default of nothing keeps
   * this constructible from a sweep.
   */
  constructor(ui, el, takeInput = () => {}) {
    this.ui = ui;
    this.el = el;
    this.takeInput = takeInput;
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
        <!-- The tip jar, on three of the forty-five rungs. See awardSupport in
             client/links.js — and no backticks in here, they would end the
             template literal this comment is written inside.

             BELOW the button and never above it. The card exists to say one
             thing and the green button is the one press on it; an ask sitting
             between the blurb and the way out is a thing you have to get past
             to dismiss a congratulation, which is how a nice moment turns into
             an advert. Down here it is read by whoever is still reading.

             Empty by default, with :empty display:none in the CSS the way
             .award-town and .award-more already are, so forty-two rungs draw
             nothing at all rather than a gap. -->
        <div class="award-tip"></div>
      </div>`;
    this.card = this.el.querySelector('.award-card');
    // The button, and only the button.
    //
    // Click-outside-to-close is right for a menu you opened and wrong for
    // something that arrived on its own: the card takes the screen *while you
    // are mid-click on the shop*, so the first press after it appears is aimed
    // at whatever you were doing — and a backdrop that dismissed would eat that
    // press, close the award, and leave you having read nothing. There is
    // exactly one thing to do here and it is a large green button in the middle
    // of it. Esc and Enter still work, because a modal that traps the keyboard
    // has to give the keyboard a way out.
    this.el.querySelector('.award-go').onclick = () => this.dismiss();
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
      // ...and the same sentence about the pointer, which the pause does not
      // cover. The backdrop note above is about the press AFTER the card
      // arrives; this is the press that was already happening WHEN it did, and
      // that one has no event coming to close it — the card is raised by the
      // shop's clock, not by anything the player pressed.
      //
      // A camera turn is the one that shows: the right button is held, the
      // pointer's next journey is across the screen to the green button, and
      // every pixel of it is applied as rotation. So the world stops, the card
      // says well done, and the shop spins wildly behind it — and the wrongness
      // outlives the card, because letting go over the backdrop is a pointerup
      // the canvas never treats as the end of anything it started.
      //
      // Only when the card first takes the screen, beside the pause and for the
      // same reason: two milestones landing together are one interruption, and
      // the second `next()` in a run happens on a press the player *did* make.
      this.takeInput();
    }

    this.el.querySelector('.award-name').textContent = won.name;
    this.el.querySelector('.award-blurb').textContent = won.blurb;
    this.el.querySelector('.award-got').innerHTML = rewardHtml(won, this.ui.state?.reveal === true);
    // The town, on every card rather than only the ones that grew it — this
    // number has never been on screen anywhere else, and a line that appeared
    // only when it moved would be a number with no scale to read it against.
    this.el.querySelector('.award-town').innerHTML = won.catchment
      ? `<b>${Math.round(won.catchment)}</b><span>people within reach of the shop</span>`
      : '';
    this.el.querySelector('.award-more').textContent = this.queue.length
      ? `${this.queue.length} more to come`
      : '';
    // Keyed off the rung's id, so a milestone that is not in the table draws
    // nothing and adding a rung can never accidentally add an ask.
    const tip = awardSupport(won.id);
    this.el.querySelector('.award-tip').innerHTML = tip
      ? `<p>${tip}</p><a href="${SUPPORT_URL}" target="_blank" rel="noopener noreferrer"
          >${ICONS.support}${SUPPORT_LABEL}</a>`
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
function rewardHtml(won, revealOn) {
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
  /**
   * ...and what has just turned up on the bar, which is the one reward here
   * that is not in `reward` at all.
   *
   * It is not a grant — `shared/reveal.js` and `goals.js` rule three both turn
   * on that — so it cannot ride in the payload beside cash and town without
   * becoming one. It is derived on this side from the rung's id instead, which
   * is also what keeps the SERVER from having to know the palette exists.
   *
   * **Last row on purpose.** Cash and crates are what the shop just got; a new
   * button is what the shop can now DO, and it is the only line that sends you
   * somewhere when you close the card. Put above the money it reads as the
   * headline of a reward it is not part of.
   *
   * Silent when the ladder is off, which is every existing save — see
   * `opensWords`, whose control this is a second copy of because the card and
   * the panel are two readers of one table.
   */
  const opens = revealOn ? opensAt(won.id) : [];
  if (opens.length) {
    rows.push(['🔧', opens.join(', '), 'now on the build bar']);
  }
  return rows.map(([ico, big, sub]) => `<li>
      <span class="aico">${ico}</span>
      <span class="atext"><b>${big}</b><i>${sub}</i></span>
    </li>`).join('');
}
