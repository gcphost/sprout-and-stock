#!/usr/bin/env node
/**
 * WRITE docs/fixtures.md FROM THE LIVE CATALOG.
 *
 * Generated rather than hand-written, and that is not laziness. Fixtures are
 * *content*: they arrive through `create_fixture` while the game is running,
 * from either person, several times an evening. A hand-kept list would be wrong
 * by the end of the session it was written in, and a wrong reference is worse
 * than none — you would trust it.
 *
 * So this reads the same registry the game reads and prints what is actually
 * there, including two things nobody would think to write down by hand:
 *
 *   - **a tier that changes no number.** `capacity_mult`, `keeps_mult` and
 *     `speed_mult` are the only knobs the sim reads, so a rung that moves none
 *     of them and costs money is a button that takes your cash and does nothing.
 *     They are flagged rather than hidden, because sometimes it is deliberate —
 *     the till ladder is priced at 0 for exactly this reason.
 *   - **how many facings a piece really has.** A shelf's capacity to the *eye*
 *     is its `surface` boards times three, which is a fact about the model
 *     rather than about the row, and diverges from `capacity_mult` silently.
 *
 *   npm run docs:fixtures
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { content } from '../server/content.js';
import { FIXTURES, GROUND, isGround, isProp, blocksCell } from '../shared/build.js';
import { kindOf, piecesOf } from '../shared/pieces.js';
import { surfacesAt, partsAt, variantsOf, isStaged } from '../shared/model.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/fixtures.md');

/** Three facings a board, the same number `shelfSlots` uses to draw them. */
const PER_ROW = 3;

const money = (n) => (n ? `$${Number(n).toFixed(2).replace(/\.00$/, '')}` : '—');

/** What the closed kind table says about where one of these may go. */
function rulesFor(kind) {
  if (isGround(kind)) {
    const g = GROUND[kind];
    // What the job IS comes off the kind's own row rather than out of a branch
    // here. This used to be a ternary over two pads, which reads as correct
    // right up until there is a third one and it describes it as the second.
    return g.pad
      ? `Ground. Painted over an area, blocks nobody, and carries a **job**: ${g.does}.`
      : 'Ground. Painted over an area, blocks nobody, and is purely a **look** — '
        + 'two floors of different colours leave byte-identical tiles.';
  }
  const f = FIXTURES[kind];
  if (!f) return 'Unknown kind — nothing in the game knows how to treat this.';
  const where = { indoor: 'Indoors only', outdoor: 'Outdoors only', any: 'Indoors or out' }[f.where] ?? f.where;
  const bits = [where];
  bits.push(blocksCell(kind) ? 'owns its cell (people walk around it)' : 'blocks nobody');
  if (f.anchor) bits.push(`worked from the side it faces (\`${f.anchor}\`)`);
  else bits.push('nobody stands at it');
  if (f.rotates) bits.push('rotates');
  if (f.at === 'ceiling') bits.push('hangs, so it needs a room to hang in');
  return `${bits.join(', ')}.`;
}

/** The rows of a piece's tier ladder, and whether each one actually does anything. */
function tierLines(row) {
  const tiers = row.tiers ?? [];
  return tiers.map((t, i) => {
    const mults = [
      t.capacity_mult !== 1 && t.capacity_mult != null ? `holds ×${t.capacity_mult}` : null,
      t.keeps_mult !== 1 && t.keeps_mult != null ? `keeps ×${t.keeps_mult}` : null,
      t.speed_mult !== 1 && t.speed_mult != null ? `speed ×${t.speed_mult}` : null,
    ].filter(Boolean);
    // Tier 1 is what a new one already is, so it is exempt: it costs 0 and is
    // supposed to move nothing.
    const dead = i > 0 && !mults.length && (t.cost ?? 0) > 0;
    const effect = mults.length ? mults.join(', ') : (i === 0 ? 'as built' : '_no effect_');
    return `${i + 1}. **${t.name}** — ${t.cost ? money(t.cost) : 'free'}, ${effect}`
      + (dead ? ' ⚠️ **pays for nothing the sim reads**' : '');
  });
}

function describe(row) {
  const kind = kindOf(row);
  const out = [];
  out.push(`#### ${row.name}`);
  out.push('');

  const facts = [`\`${row.id}\``, `kind \`${kind}\``];
  if (isGround(kind)) facts.push(`${money(row.cost)} per tile`);
  else if (row.cost) facts.push(`${money(row.cost)} to build`);
  else facts.push('priced by the upgrade that sells its kind');
  out.push(facts.join(' · '));
  out.push('');

  if (row.surface) {
    const s = row.surface;
    out.push(`Surface \`${s.color}\`${s.accent ? ` / \`${s.accent}\`` : ''}, `
      + `${s.pattern ?? 'plain'} repeat. No model — ground *is* the cell.`);
    out.push('');
  } else {
    const rows = surfacesAt(row.model, 1);
    const parts = partsAt(row.model, 1);
    const bits = [`${parts.length} part${parts.length === 1 ? '' : 's'}`];
    if (isStaged(row.model)) bits.push(`${row.model.stages.length} stages, driven by tier`);
    if (rows.length) bits.push(`**${rows.length} board${rows.length === 1 ? '' : 's'} of goods** (${rows.length * PER_ROW} facings drawn)`);
    else if (!isProp(kind)) bits.push('no `surface` boards — goods pile on its roof');
    if (parts.some((p) => (p.alpha ?? 1) < 1)) bits.push('has glass');
    if (parts.some((p) => p.drift)) bits.push('drifts (steam/vapour)');
    if (parts.some((p) => p.seam)) bits.push('seams against a neighbour');
    out.push(bits.join(' · '));
    out.push('');
  }

  if (row.yields?.cash) {
    out.push(`💰 **Earns ${money(row.yields.cash)} every ${row.yields.every} in-game minutes**, `
      + 'as a pile of cash on its own tile that somebody has to walk over and collect.');
    out.push('');
  }
  if (row.charm) {
    out.push(`✨ Charm **${row.charm}** — raises how far word of the shop travels `
      + '(catchment), saturating across the whole shop.');
    out.push('');
  }
  if (row.emits) {
    out.push(`💡 Emits \`${row.emits.color}\`, intensity ${row.emits.intensity}, `
      + `range ${row.emits.range} tiles. (Eight lights are real at once — see \`render/lights.js\`.)`);
    out.push('');
  }

  const variants = variantsOf(row).filter((v) => v.id);
  if (variants.length) {
    out.push(`Shapes: Standard, ${variants.map((v) => v.name).join(', ')} `
      + '— looks only, same price and same ladder.');
    out.push('');
  }

  const ladder = tierLines(row);
  if (ladder.length > 1) { out.push(...ladder); out.push(''); }

  return out.join('\n');
}

const c = content();
const rows = c.fixtures ?? [];

const GROUPS = [
  {
    title: 'Fixtures',
    blurb: 'Things you own, that stand in a cell, that the generator has a budget for.',
    kinds: Object.keys(FIXTURES).filter((k) => !isProp(k)),
  },
  {
    title: 'Decorations',
    blurb: 'They weigh nothing, on purpose. No tile stamped, no generator budget, '
      + 'no working spot reserved — so people walk past them and no shop that was '
      + 'walkable stops being so. Anything that must be walked around is a shelf.',
    kinds: Object.keys(FIXTURES).filter((k) => isProp(k)),
  },
  {
    title: 'Ground',
    blurb: 'Not placed — **painted**, over an area, priced per tile. These have no '
      + 'anchor and block nobody, because they are not standing in a cell, they *are* '
      + 'the cell.',
    kinds: Object.keys(GROUND),
  },
];

const dead = [];
for (const r of rows) {
  (r.tiers ?? []).forEach((t, i) => {
    const flat = [t.capacity_mult, t.keeps_mult, t.speed_mult].every((m) => m == null || m === 1);
    if (i > 0 && flat && (t.cost ?? 0) > 0) dead.push(`\`${r.id}\` → **${t.name}** (${money(t.cost)})`);
  });
}

const md = [];
md.push('# The build catalog');
md.push('');
md.push('**Generated — do not edit.** `npm run docs:fixtures` rewrites this from the');
md.push('live content database. Fixtures arrive through `create_fixture` while the game');
md.push('is running, so a hand-kept list would be wrong by the end of the evening, and a');
md.push('reference you cannot trust is worse than no reference at all.');
md.push('');
md.push('**Kinds are code; pieces are content.** A row here is a *piece*: its own id,');
md.push('model, variants, tier ladder and price. It names a *kind* from the closed set in');
md.push('`shared/build.js`, and that set is closed because where a thing may go, whether');
md.push('it blocks and which side you work it from are behaviour. So there can be four');
md.push('planters and two shelf designs, but not a new kind — see [building.md](building.md).');
md.push('');
md.push(`${rows.length} pieces across ${new Set(rows.map(kindOf)).size} kinds.`);
md.push('');

if (dead.length) {
  md.push('> ⚠️ **Tiers that change no number.** `capacity_mult`, `keeps_mult` and');
  md.push('> `speed_mult` are the only knobs the sim reads, so these rungs take money and');
  md.push('> do nothing. Sometimes deliberate — the till ladder is priced at 0 because');
  md.push('> nothing reads a till\'s speed yet — but a *paid* one is a bug:');
  md.push('>');
  for (const d of dead) md.push(`> - ${d}`);
  md.push('');
}

for (const g of GROUPS) {
  md.push(`## ${g.title}`);
  md.push('');
  md.push(g.blurb);
  md.push('');
  for (const kind of g.kinds) {
    const mine = piecesOf(rows, kind);
    md.push(`### \`${kind}\``);
    md.push('');
    md.push(rulesFor(kind));
    md.push('');
    if (!mine.length) {
      md.push('_Nothing authored yet._'
        + (isProp(kind) || isGround(kind)
          ? ' A kind that *is* its art gets no palette entry until somebody draws one.'
          : ' It still builds — an undrawn fixture renders as a plain block.'));
      md.push('');
      continue;
    }
    for (const r of mine) md.push(describe(r));
  }
}

md.push('---');
md.push('');
md.push('Authoring notes that cost real debugging time:');
md.push('');
md.push('- **Eight parts per stage** is the cap. The shipped shelf is exactly 6/7/8 for');
md.push('  that reason — build the silhouette from the budget, not from what looks nicest.');
md.push('- **A model faces east.** `-x` is its back, `+x` its face. Goods run along');
md.push('  whichever horizontal axis a `surface` board is *longer* on, so make boards');
md.push('  deeper (z) than wide (x) or a corner unit files its stock into the wall.');
md.push('- **A hanging piece must hang.** `prop-ceiling` parts sit at negative `y`;');
md.push('  `verify:build` asserts it, because one at `y: 0` is a sign lying on the floor.');
md.push('- **`rot` turns a part about Y and nothing else.** Nothing can lean.');
md.push('- **A variant is a look; a tier is a number.** A new shape can never move the');
md.push('  balance, which is why restyling something already built is free and keeps its');
md.push('  stock, and why no shape anybody draws needs `simulate` re-run.');
md.push('- **`yields` and `charm` are the exception to that.** They are the only fields');
md.push('  here that move money, so a piece carrying either needs `simulate` averaged over');
md.push('  ten seeds before you believe the number — one seed is not a measurement.');
md.push('');

writeFileSync(OUT, `${md.join('\n')}\n`);
console.log(`docs/fixtures.md — ${rows.length} pieces`
  + `${dead.length ? `, ${dead.length} dead tier(s) flagged` : ''}`);
