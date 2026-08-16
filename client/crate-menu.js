/**
 * WHAT IS ON THIS TILE — the crates, one row each, newest on top.
 *
 * Crates stack. A shelf of three things strips into three of them on one tile,
 * and a pad that has run out of cells doubles up, so "point at the one you
 * want" stopped being a fair thing to ask: a crate stands about a fifth of a
 * tile tall, which at the default zoom is a band of a dozen or so pixels, and
 * the ones underneath show nothing but that band. Aiming still works and is
 * still what a tap does — this is the answer for when the band is too thin to
 * hit, and for reading what is buried in a pile without dismantling it.
 *
 * It hangs off the long press, where it costs nothing: "tap goes, hold looks"
 * is the rule the whole shop floor already runs on, and a crate was the one
 * thing you could point at that had no answer to being looked at.
 *
 * There is no notion of a stack on the server, and there must not be — a crate
 * is a spot on the floor and `take` names one by id. So this is a list of what
 * is standing on one tile, worked out here, and taking the bottom one out from
 * under two others is allowed for exactly the same reason it is allowed to
 * strip a shelf from across the room: the walk is the cost.
 */

import { ICONS } from './icons.js';

/**
 * Every crate standing on one tile, bottom of the pile first.
 *
 * Exported because the tap asks the same question before it decides what it
 * means: one crate is a verb and a pile is a list, and both have to agree about
 * what counts as a pile.
 */
export function cratesAt(ui, at) {
  const x = Math.round(at?.x ?? NaN);
  const z = Math.round(at?.z ?? NaN);
  return (ui.state?.deliveries ?? [])
    .filter((d) => Math.round(d.x) === x && Math.round(d.z) === z)
    // The renderer stacks them in this order, so the list and the pile agree
    // about which one is on top. Both read the id rather than array order,
    // which shuffles as crates are taken.
    .sort((a, b) => (Number(String(a.id).slice(4)) || 0) - (Number(String(b.id).slice(4)) || 0));
}

/** What redrawing depends on — the pile, and how much is in each of them. */
const signature = (list) => list.map((d) => `${d.id}:${d.item_id}:${d.qty}`).join('|');

/**
 * Where in the pile this one is, in words.
 *
 * The point of saying it is that the picture and the list have to be the same
 * pile: you can see which crate is on top, so the row that says "on top" is the
 * one you can already point at, and everything below it is what this menu is
 * for.
 */
function place(i, n) {
  if (n === 1) return 'on its own';
  if (i === n - 1) return 'on top';
  if (i === 0) return n === 2 ? 'underneath' : `at the bottom, under ${n - 1}`;
  return `under ${n - 1 - i}`;
}

export function showCrates(ui, at) {
  if (!at) return;
  const x = Math.round(at.x);
  const z = Math.round(at.z);
  const list = cratesAt(ui, { x, z });
  if (!list.length) { ui.closePanel(); return; }

  ui.openPanel = 'crates';
  // Not a section, so nothing on the rail is lit — the same as a fixture's menu
  // and a hire's.
  ui.rail.setOpen(null);
  ui.crateRef = { x, z };
  ui.panelTick = tickCrates;
  ui._crMenuKey = signature(list);

  // Top of the pile first, because that is the order you would take them off
  // and the order they are drawn up the screen.
  const rows = [...list].reverse().map((d, n) => {
    const i = list.length - 1 - n;
    return {
      icon: ICONS.crate,
      name: ui.itemName(d.item_id),
      sub: place(i, list.length),
      right: `x${d.qty}`,
      // One verb, the same one the tap sends. It walks you there and fills your
      // hands when you arrive — the errand, not a teleport, which is the whole
      // reason `take` names its target instead of handing goods over.
      run: () => ui.net.send('take', { palletId: d.id }),
    };
  });

  ui.showPanel(`${ICONS.crate} ${list.length === 1 ? 'A crate' : `${list.length} crates`}`,
    rows.map((r, i) => ui.rowHtml(r, i)).join('')
    + '<div class="foot">Pick one and you will go and get it. '
    + 'A crate holds one kind of thing, so a pile is a pile of different things.</div>',
    `crates:${x},${z}`);
  ui.wireRows(rows);
}

/**
 * Keep the open list honest against the snapshot.
 *
 * By TILE rather than by the crates it was opened on, because the pile is the
 * thing that persists: a stocker tidying the top one away, or the other player
 * dropping another on it, should leave the menu open on what is still there.
 * An empty tile closes it — there is nothing left to be a list of.
 */
function tickCrates(ui) {
  if (ui.openPanel !== 'crates' || !ui.crateRef) return;
  const list = cratesAt(ui, ui.crateRef);
  if (!list.length) { ui.closePanel(); return; }
  if (signature(list) !== ui._crMenuKey) showCrates(ui, ui.crateRef);
}
