/**
 * The rail down the right-hand side. Nothing here knows what a style IS — it
 * reads `CONTROLS` and writes back into the state object it was handed, which
 * is what keeps adding a knob to a one-line change in `presets.js`.
 */

/**
 * Build the rail once, and hand back a `sync` that re-reads every control.
 *
 * `sync` rather than a rebuild, because a preset press moves twenty values at
 * once and rebuilding the DOM under a slider somebody is dragging drops the
 * pointer capture — the slider stops following the mouse halfway through a
 * drag, which reads as the page having hung.
 */
export function buildRail(host, controls, state, onChange) {
  const rows = [];

  for (const section of controls) {
    const wrap = document.createElement('section');
    wrap.className = 'grp';
    const h = document.createElement('h3');
    h.textContent = section.group;
    wrap.append(h);

    for (const c of section.items) {
      const row = document.createElement('label');
      row.className = `row row-${c.type}`;

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.label;

      const out = document.createElement('span');
      out.className = 'val';

      let input;
      if (c.type === 'range') {
        input = document.createElement('input');
        input.type = 'range';
        input.min = c.min;
        input.max = c.max;
        input.step = c.step;
      } else if (c.type === 'toggle') {
        input = document.createElement('input');
        input.type = 'checkbox';
      } else if (c.type === 'color') {
        input = document.createElement('input');
        input.type = 'color';
      } else {
        input = document.createElement('select');
        for (const [value, label] of c.options) {
          const o = document.createElement('option');
          o.value = value;
          o.textContent = label;
          input.append(o);
        }
      }
      input.className = 'ctl';

      const read = () => {
        if (c.type === 'range') return Number(input.value);
        if (c.type === 'toggle') return input.checked;
        return input.value;
      };
      const write = () => {
        const v = state[c.key];
        if (c.type === 'range') {
          input.value = v;
          // Trailing zeros dropped, because a column of "1.00" is a column of
          // noise and the only number anybody reads here is the one moving.
          out.textContent = Number(v).toFixed(c.step < 1 ? 2 : 0).replace(/\.?0+$/, '') || '0';
        } else if (c.type === 'toggle') {
          input.checked = !!v;
          out.textContent = '';
        } else if (c.type === 'color') {
          input.value = v;
          out.textContent = String(v).toUpperCase();
        } else {
          input.value = v;
          out.textContent = '';
        }
      };

      const fire = () => { onChange(c.key, read()); write(); };
      input.addEventListener('input', fire);
      input.addEventListener('change', fire);

      row.append(name, input, out);
      wrap.append(row);
      rows.push({ c, row, write });
    }

    host.append(wrap);
  }

  return function sync() {
    for (const { c, row, write } of rows) {
      const on = !c.when || c.when(state);
      row.classList.toggle('off', !on);
      write();
    }
  };
}
