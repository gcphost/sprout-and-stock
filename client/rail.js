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

export class Rail {
  constructor(ui, el) {
    this.ui = ui;
    this.el = el;
    this.badges = {};
    this.render();
  }

  render() {
    this.el.innerHTML = RAIL_ITEMS.map((s) => `
      <button class="rail-btn" data-rail="${s.id}" title="${s.name} — ${s.key.toUpperCase()}">
        <span class="ico">${s.icon}</span>
        <span class="kb">${s.key.toUpperCase()}</span>
        <span class="badge" hidden></span>
      </button>`).join('');

    this.el.querySelectorAll('[data-rail]').forEach((b) => {
      const item = railItemById(b.dataset.rail);
      b.onclick = () => (item?.mode ? this.ui.toggleBuild() : this.ui.toggleSection(b.dataset.rail));
    });
  }

  /** Light the icon whose menu is open. `null` when nothing is. */
  setOpen(id) {
    for (const s of RAIL_ITEMS) {
      // A mode button is lit by the mode, not by a panel — `update` owns it.
      if (s.mode) continue;
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
    this.el.querySelector('[data-rail="build"]')?.classList.toggle('on', !!this.ui.buildOn);

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
  }
}
