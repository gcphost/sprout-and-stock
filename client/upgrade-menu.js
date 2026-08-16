/**
 * One menu per upgrade.
 *
 * The upgrade list moved to the bottom bar, and a bar entry is one press — which
 * is fine for arming a shelf and wrong for a permanent, unrefundable $20,000
 * purchase. So the bar opens this instead: what it actually does, in numbers off
 * its own payload, and one button that spends the money.
 *
 * Functions take `ui` first rather than living on it, the same as
 * `fixture-menu.js` and `worker-menu.js` — this reads the snapshot and sends a
 * message, it is not part of the HUD's state.
 */

import { ICONS } from './icons.js';
import { act } from './fixture-menu.js';

/** Names and descriptions are authored over MCP, so never raw. */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/**
 * What a kind of upgrade sells, in the shop's own words.
 *
 * Read off `payload` rather than written into the description, because the
 * description is authored and the payload is what the sim actually obeys — a
 * row edited over MCP to 30% off should say 30% here without anybody
 * remembering to rewrite its prose. A kind nobody has described falls through
 * to the description alone, which is the honest answer for one nobody has.
 */
function sells(u) {
  const p = u.payload ?? {};
  if (p.discount != null) return [['Off every one you build', `${Math.round(p.discount * 100)}%`]];
  if (p.carry != null) return [['Carry at once', `${p.carry}`]];
  if (p.speedMult != null) return [['Walking speed', `${p.speedMult}×`]];
  if (p.reach != null) return [['People within reach', `${p.reach}`]];
  return [];
}

export function showUpgrade(ui, upgradeId) {
  const u = (ui.catalog.upgrades ?? []).find((x) => x.id === upgradeId);
  if (!u) { ui.closePanel(); return; }

  ui.openPanel = 'upgrade';
  // Like a fixture's or a hire's menu, this isn't a section, so nothing on the
  // rail is lit — the bar it came off is what says where you are.
  ui.rail.setOpen(null);
  ui.upgradeRef = upgradeId;
  ui.panelTick = tickUpgrade;
  ui._upKey = signature(ui, u);

  const owned = ui.ownedUpgrades ?? [];
  const have = owned.includes(u.id);
  const missing = (u.requires ?? []).filter((r) => !owned.includes(r));
  const afford = (ui._cash ?? 0) >= u.cost;

  const line = (label, value) => `<div class="fx-line"><span>${label}</span><b>${value}</b></div>`;
  const head = `<div class="fx-detail">
    ${sells(u).map(([k, v]) => line(k, esc(v))).join('')}
    ${line('Costs', `$${u.cost.toFixed(0)}`)}
    ${have ? line('Owned', 'yes') : ''}
  </div>`;

  const parts = [`<div class="pnl-head">${head}</div>`];
  parts.push(`<div class="foot">${esc(u.description)}</div>`);

  // What it wants first, named. A locked row that only says "locked" is one you
  // have to go and work out, and the ladder is the whole shape of this menu.
  if (missing.length) {
    parts.push('<div class="sep">Needs first</div>');
    parts.push(missing.map((id) => {
      const req = (ui.catalog.upgrades ?? []).find((x) => x.id === id);
      return act(`goto:${id}`, ICONS.upgrades, req?.name ?? id,
        req ? `$${req.cost.toFixed(0)} — tap to open it` : 'no longer in the catalogue',
        { off: !req });
    }).join(''));
  }

  const foot = [];
  if (have) {
    foot.push(act('owned', ICONS.upgrades, 'Already yours',
      'An upgrade is permanent. There is nothing to buy twice.', { off: true }));
  } else {
    const why = missing.length ? 'Buy what it needs first.'
      : (!afford ? 'You cannot afford it yet.' : 'Permanent, and there is no selling it back.');
    foot.push(act('buy', ICONS.upgrades, 'Buy it', why,
      { off: !!missing.length || !afford, right: `$${u.cost.toFixed(0)}` }));
  }
  parts.push(`<div class="pnl-foot">${foot.join('')}</div>`);

  ui.showPanel(`${ICONS.upgrades} ${esc(u.name)}`, parts.join(''));
  wire(ui, u);
}

/**
 * Everything the open menu draws from, so it redraws when any of it moves — and
 * only then. Cash is in here because it is what greys the button out, and it
 * changes every time a customer pays.
 */
function signature(ui, u) {
  return JSON.stringify([u.id, u.cost, (ui.ownedUpgrades ?? []).length,
    Math.floor(ui._cash ?? 0), ui.catalog.version]);
}

function tickUpgrade(ui) {
  if (ui.openPanel !== 'upgrade' || !ui.upgradeRef) return;
  const u = (ui.catalog.upgrades ?? []).find((x) => x.id === ui.upgradeRef);
  if (!u) { ui.closePanel(); return; }
  if (signature(ui, u) !== ui._upKey) showUpgrade(ui, ui.upgradeRef);
}

function wire(ui, u) {
  ui.el.panelBody.querySelectorAll('[data-act]').forEach((el) => {
    const what = el.dataset.act;
    el.onclick = () => {
      if (what === 'buy') { ui.net.send('buy-upgrade', { upgradeId: u.id }); return; }
      // Walking the ladder: tapping what it needs opens that one, so a chain of
      // requirements is something you can follow rather than go and look up.
      if (what.startsWith('goto:')) showUpgrade(ui, what.slice(5));
    };
  });
}
