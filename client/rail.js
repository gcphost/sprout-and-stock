/**
 * The rail: one icon per menu, down the top-right corner.
 *
 * It is the only permanently visible thing on screen that says the game has
 * menus at all — before it, three unrelated letter keys were the whole
 * discovery story and a line of prose in the corner was doing the explaining.
 *
 * Icons come from SECTIONS, so the rail can never drift out of step with what
 * is actually openable.
 */

import { SECTIONS } from './sections.js';

export class Rail {
  constructor(ui, el) {
    this.ui = ui;
    this.el = el;
    this.badges = {};
    this.render();
  }

  render() {
    this.el.innerHTML = SECTIONS.map((s) => `
      <button class="rail-btn" data-sec="${s.id}" title="${s.name} — ${s.key.toUpperCase()}">
        <span class="ico">${s.icon}</span>
        <span class="kb">${s.key.toUpperCase()}</span>
        <span class="badge" hidden></span>
      </button>`).join('');

    this.el.querySelectorAll('[data-sec]').forEach((b) => {
      b.onclick = () => this.ui.toggleSection(b.dataset.sec);
    });
  }

  /** Light the icon whose menu is open. `null` when nothing is. */
  setOpen(id) {
    this.el.querySelectorAll('[data-sec]').forEach((b) => {
      b.classList.toggle('on', b.dataset.sec === id);
    });
  }

  /**
   * The display half of the rail: what each menu would tell you if you opened
   * it. Recomputed every snapshot but only written to the DOM when the text
   * changes — this runs at 10Hz over a live canvas.
   */
  update() {
    // Build mode is a state of the world, not a menu, so the rail says so even
    // when the menu itself is closed. An armed ghost with nothing on screen
    // explaining it is the whole complaint this answers.
    this.el.querySelector('[data-sec="build"]')
      ?.classList.toggle('mode', this.ui.buildOn && this.ui.openPanel !== 'build');

    for (const s of SECTIONS) {
      if (!s.badge) continue;
      const val = s.badge(this.ui) ?? null;
      if (val === this.badges[s.id]) continue;
      this.badges[s.id] = val;
      const el = this.el.querySelector(`[data-sec="${s.id}"] .badge`);
      if (!el) continue;
      el.textContent = val ?? '';
      el.hidden = val === null;
    }
  }
}
