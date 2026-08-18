/**
 * The rail: one icon per menu, down the top-right corner.
 *
 * It is the only permanently visible thing on screen that says the game has
 * menus at all — before it, three unrelated letter keys were the whole
 * discovery story and a line of prose in the corner was doing the explaining.
 *
 * Icons come from RAIL_ITEMS, so the rail can never drift out of step with what
 * is actually openable. One of them isn't a menu: Build toggles a mode and has
 * no panel behind it, which is why a press has to ask which sort it pressed.
 */

import { RAIL_ITEMS, railItemById } from './sections.js';
import { tip } from './tip.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * What a button says about itself when nothing is happening on it.
 *
 * The same sentence the Help panel prints under the name (`SECTION_KEYS`), so
 * the two can never disagree about what a menu is for — a panel is described by
 * its own header and a bar has no header, which is why it is either of two
 * fields rather than one.
 */
const blurbOf = (s) => s.title ?? s.blurb ?? '';

/**
 * The ring, as the button's own outline.
 *
 * A circle would have been less work and is the wrong shape: a 40px squircle
 * with a 12px radius does not have a circle inscribed in it that reads as
 * belonging to it — you get a coaster sat on a card. Tracing the border means
 * the countdown is the button rather than a thing stuck to it, and it leaves
 * the middle for the icon and the corner for the badge, both of which already
 * live there.
 *
 * Drawn from the top centre and clockwise, because that is where a clock face
 * starts and this is a clock. The path is inset 1.5px so the stroke sits ON the
 * edge rather than half outside it, and the radius is inset with it (12 − 1.5)
 * or the corners bulge away from the ones underneath.
 */
const RING_PATH = 'M20 1.5 H28 A10.5 10.5 0 0 1 38.5 12 V28 A10.5 10.5 0 0 1 28 38.5'
  + ' H12 A10.5 10.5 0 0 1 1.5 28 V12 A10.5 10.5 0 0 1 12 1.5 Z';

export class Rail {
  constructor(ui, el) {
    this.ui = ui;
    this.el = el;
    this.badges = {};
    this.rings = {};
    this.render();
  }

  render() {
    // `data-tip` rather than `title`. The two do not stack: a native tooltip
    // would still appear a second later, underneath the drawn one, saying the
    // same thing in the operating system's handwriting — so the attribute is
    // replaced rather than added to. `aria-label` is what keeps the name
    // available to a screen reader, which is the half `title` was also doing.
    this.el.innerHTML = RAIL_ITEMS.map((s) => `
      <button class="rail-btn" data-rail="${s.id}" aria-label="${esc(s.name)}"
        data-tip-wait
        data-tip="${esc(s.name)}" data-tip-key="${s.key.toUpperCase()}"
        ${blurbOf(s) ? `data-tip-note="${esc(blurbOf(s))}"` : ''}>
        ${s.ring ? `<svg class="ring" viewBox="0 0 40 40" aria-hidden="true">
          <path class="trk" d="${RING_PATH}"/><path class="arc" d="${RING_PATH}"/></svg>` : ''}
        <span class="ico">${s.icon}</span>
        <span class="kb">${s.key.toUpperCase()}</span>
        <span class="badge" hidden></span>
        ${s.ring ? '<span class="cargo" hidden></span>' : ''}
      </button>`).join('');

    // Measured off the path rather than worked out by hand, so the geometry
    // above can be tweaked without a magic number here silently going stale —
    // a dasharray that is a little wrong draws a ring that never quite closes.
    for (const arc of this.el.querySelectorAll('.ring .arc')) {
      const len = arc.getTotalLength();
      arc.style.strokeDasharray = len;
      arc.style.strokeDashoffset = len;
      arc.dataset.len = len;
    }

    this.el.querySelectorAll('[data-rail]').forEach((b) => {
      const item = railItemById(b.dataset.rail);
      // Three kinds of press, and the button looks the same for all three:
      // a mode (Build) toggles the world, a bar (Staff) claims the bottom
      // strip, and everything else opens a panel.
      b.onclick = () => {
        if (item?.mode) this.ui.pressBuild();
        else if (item?.bar) this.ui.toggleBar(item.bar);
        else this.ui.toggleSection(b.dataset.rail);
      };
    });
  }

  /**
   * A word above the rail, for a couple of seconds.
   *
   * The toast says what happened (`Build mode enabled`) and it says it at the
   * top of the screen, which is where the shop talks to you. What a *second
   * press* of a button does is not news about the shop — it is a fact about the
   * nav, and it belongs over the nav, or it is an instruction about something at
   * the bottom of the screen delivered at the top of it.
   *
   * Same pill, same place and the same job as `#build-hint`, which is the line
   * that says what the palette is holding — this is that line for the press
   * before the palette exists.
   *
   * One element, made once, the way the tooltip is: there is only ever one of
   * these on screen.
   */
  note(text) {
    clearTimeout(this._noteTimer);
    if (!this.noteEl) {
      this.noteEl = document.createElement('div');
      this.noteEl.id = 'rail-note';
      document.body.appendChild(this.noteEl);
    }
    const el = this.noteEl;
    el.textContent = text;
    // Centred on the whole rail rather than on the button that raised it, which
    // is the build hint's shape and the same reason: a pill that jumps sideways
    // to sit over whichever icon is talking reads as a different thing each
    // time, where one that always arrives in the middle is a place you learn.
    // The rail is centred on the screen, so `left: 50%` does the sideways half
    // in CSS and the only measurement here is how high up the rail's top edge
    // is — which moves when it wraps on a narrow window.
    el.style.bottom = `${window.innerHeight - this.el.getBoundingClientRect().top + 8}px`;
    // Two frames for the same reason the tooltip takes two: the box has to be
    // where it is going before the fade starts, or it slides in from wherever
    // the last one was.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    this._noteTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  /** ...and take it away, because the thing it was telling you to do is done. */
  clearNote() {
    clearTimeout(this._noteTimer);
    this.noteEl?.classList.remove('show');
  }

  /** Light the icon whose bar is up. `null` when the bottom strip is empty. */
  setBar(which) {
    for (const s of RAIL_ITEMS) {
      if (!s.bar) continue;
      this.el.querySelector(`[data-rail="${s.id}"]`)?.classList.toggle('on', s.bar === which);
    }
  }

  /** Light the icon whose menu is open. `null` when nothing is. */
  setOpen(id) {
    for (const s of RAIL_ITEMS) {
      // A mode or a bar is lit by what it owns, not by a panel — see above.
      if (s.mode || s.bar) continue;
      this.el.querySelector(`[data-rail="${s.id}"]`)?.classList.toggle('on', s.id === id);
    }
  }

  /**
   * The display half of the rail: what each menu would tell you if you opened
   * it. Recomputed every snapshot but only written to the DOM when the text
   * changes — this runs at 10Hz over a live canvas.
   */
  update() {
    // Build mode is a state of the world rather than an open menu, so its button
    // is lit by the mode itself. An armed ghost with nothing on screen explaining
    // it is the whole complaint this answers.
    //
    // Two states rather than one, because it is two presses (`pressBuild`): lit
    // says the world is in build mode, and `open` says the palette is up. The
    // first press used to always bring the second's bar with it, so a mode with
    // no bar was a mode nothing on screen mentioned — this button is now the
    // only thing that says it, which makes the difference between the two the
    // thing it has to draw rather than a nicety.
    const b = this.el.querySelector('[data-rail="build"]');
    b?.classList.toggle('on', !!this.ui.buildOn);
    b?.classList.toggle('open', this.ui.bar === 'build');

    for (const s of RAIL_ITEMS) {
      if (!s.badge) continue;
      const val = s.badge(this.ui) ?? null;
      if (val === this.badges[s.id]) continue;
      this.badges[s.id] = val;
      const el = this.el.querySelector(`[data-rail="${s.id}"] .badge`);
      if (!el) continue;
      el.textContent = val ?? '';
      el.hidden = val === null;
    }

    this.updateRings();
  }

  /**
   * The countdown half: a wait you can watch, rather than a number you have to
   * open a panel to read.
   *
   * Diffed on the ring's *rounded* position and not on its raw one, which is
   * the only thing keeping this cheap. `in` moves every single tick — it is the
   * one field the supplier's `live` signature deliberately leaves out for that
   * reason — so writing the arc straight from it would touch the DOM ten times
   * a second for the entire six hours an order is in flight. A percent moves a
   * hundred times over the whole journey, and the CSS transition covers each
   * step, so what you see is smooth motion off about one write a minute.
   */
  updateRings() {
    for (const s of RAIL_ITEMS) {
      if (!s.ring) continue;
      const v = s.ring(this.ui) ?? null;
      const key = v ? `${Math.round(v.p * 100)}|${v.onVan}|${v.total}|${v.note}` : '';
      if (key === this.rings[s.id]) continue;
      this.rings[s.id] = key;

      const btn = this.el.querySelector(`[data-rail="${s.id}"]`);
      if (!btn) continue;
      btn.classList.toggle('waiting', !!v);
      // The van is at the door rather than on the road, which is the one moment
      // in the whole wait where something is actually happening — and where a
      // full ring sitting still would read as a countdown that finished and
      // then stopped meaning anything.
      btn.classList.toggle('landing', v?.onVan === true);

      // What the button is DOING replaces what it is FOR, rather than joining
      // it. "Buy stock in, delivered to the bay" is a sentence you need once;
      // "18 on the way — 6 on the 14:00 van" is one you came back to read, and
      // stacking the two puts the live half second every time.
      if (v) {
        btn.dataset.tipNote = v.note;
        btn.dataset.tipTone = v.onVan ? 'good' : 'warn';
      } else {
        btn.dataset.tipNote = blurbOf(s);
        delete btn.dataset.tipTone;
      }
      // ...and if that button is the one under the pointer right now, the tip
      // showing the old sentence is repainted where it stands.
      tip.refresh(btn);

      // How much is out there, which the ring on its own cannot say — an arc a
      // third of the way round is the same picture for one crate and for forty.
      // It counts EVERY pending order rather than the van the ring is drawn
      // from: the question this answers is "have I already ordered that", and
      // an order two vans out still means yes.
      const cargo = btn.querySelector('.cargo');
      if (cargo) {
        cargo.textContent = v ? String(v.total) : '';
        cargo.hidden = !v;
      }

      const arc = btn.querySelector('.ring .arc');
      if (!arc) continue;
      const len = Number(arc.dataset.len);
      arc.style.strokeDashoffset = len * (1 - (v?.p ?? 0));
    }
  }
}
