#!/usr/bin/env node
/**
 * VERIFY: THE PALETTE THAT UNFOLDS.
 *
 * Twenty-six build kinds arriving in one screen is what "too many buttons"
 * means, and `shared/reveal.js` is the answer: a gate table that hides a tool
 * until a rung of the ladder lands. Nothing in here can be looked at, which is
 * why it ships WITH the feature the way `verify:price` and `verify:grace` did —
 * a shop whose conveyors have not turned up yet and a shop that never had
 * conveyors are the same screenshot of the same bar, and the shop is the same
 * shop either way. Only what you can *find* moved.
 *
 * Its control is the assertion that decides whether this is opt-in or a change
 * to every save in existence, and it is doubled because two populations have to
 * come through untouched: a save that has never heard of the field (`reveal`
 * absent ⇒ false ⇒ every tool, exactly as the bar shipped), and a shop that has
 * deliberately switched it off.
 *
 * Its centrepiece is the rule that cannot be checked by reading the table, and
 * it is the one that would have shipped broken. **A gate may never be the thing
 * it gates.** Five rungs of the ladder measure *having built the thing* —
 * `first-kitchen` is "put an appliance on the floor", and `break-room`,
 * `car-park`, `stockroom` and `first-warmer` are the same shape — so gating
 * `station` behind `first-kitchen` produces a button that appears at the exact
 * moment you no longer need it to appear. That is a feature which is off for
 * ever while reading as correctly authored: the table looks sensible, the ids
 * all resolve, nothing errors, and the tool is simply never reachable. So it is
 * asserted EMPIRICALLY rather than against a list of banned ids — for every
 * gate, standing the gated kind up in a shop must not move the gating
 * milestone's own measure. A list would have to be maintained by whoever adds
 * the forty-sixth rung; this cannot go stale.
 *
 * The rest:
 *
 * - **A reveal is not a rule.** The server must place a gated kind perfectly
 *   happily with the ladder on — MCP, a sweep, the balance bot and a co-op guest
 *   whose bar is further along all send builds the local palette would not have
 *   offered. The day `placeFixture` consults this, the reveal has become a
 *   permission and every one of those breaks.
 * - **Unlisted is visible**, which is the safe direction: a kind nobody wrote a
 *   row for ships on the bar, where a default of hidden would be a fixture that
 *   prices, places and renders and can never be found.
 * - **Out and back**, because CLAUDE.md's named-field trap has bitten `paint`
 *   for five steps and `difficulty` for an hour: the field has to survive
 *   `serialize`, `saveState` and the `Game.create` payload, and the half that is
 *   never obvious is the way home.
 * - **Turning it off is not one-way.** `done` goes on climbing while the ladder
 *   is off, so a shop that unlocks everything on day 40 and changes its mind on
 *   day 41 gets back the bar it had earned rather than the opening four buttons.
 * - **The ladder is a ladder.** At least three distinct rungs must be in use, or
 *   the table is a boolean wearing a milestone id and every tool arrives at
 *   once — the `packs` trap said about a gate.
 *
 * What it cannot reach is the client filter itself: `client/sections.js` imports
 * the audio manifest, which pulls `.ogg` files node will not load, so
 * `computeBuildTools` is unreachable from here. The two claims that live there
 * and are therefore NOT covered are written down rather than skipped quietly —
 * the cache key (a milestone landing must invalidate `toolCache`, or the bar
 * grows no button until somebody authors content, which reads as the reward not
 * having been paid) and removal-rather-than-flagging. Both are argued at the
 * call site.
 *
 * Runs on ephemeral Games and writes nothing at all — no content rows, no save,
 * no cleanup.
 *
 *   node scripts/verify-reveal.js
 */

import { Game } from '../server/sim/index.js';
import { MILESTONES, silenceMilestones } from '../server/sim/goals.js';
import { REVEAL, SAFE_GATES, TUTORIAL_KINDS, RETIRED_PIECES, gateFor, opensAt, toolRevealed, revealSig, pieceOffered } from '../shared/reveal.js';
import { FIXTURES, GROUND_KINDS, BUILD_KINDS, canPlaceCleanly } from '../shared/build.js';
import { content } from '../server/content.js';
import { pieceFor, kindOf } from '../shared/pieces.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

const byId = Object.fromEntries(MILESTONES.map((m) => [m.id, m]));

/** A shop with nothing on it. No layout needed — every claim here is a lookup. */
function fresh(done = []) {
  const g = Game.create({ worldId: 'verify-reveal', seed: 'reveal', ephemeral: true });
  silenceMilestones(g);
  g.milestones = { done: [...done], known: [...done] };
  return g;
}

/** Every tool the palette can offer, as the filter sees them. */
const allTools = () => [
  ...BUILD_KINDS.map((k) => ({ id: k, kind: k })),
  // The shell tools have no kind — a wall is built by the renderer off
  // `EDGE_STYLE` — so they are keyed by id, and the two the table names are the
  // two that have to be represented here or the id branch is never exercised.
  { id: 'wall' }, { id: 'door' }, { id: 'curtain' }, { id: 'shutter' }, { id: 'arch' },
];

// ---------------------------------------------------------------------------
// 1. The control, doubled: this changed nothing for anybody who is not using it.
// ---------------------------------------------------------------------------
{
  const done = new Set();
  for (const t of allTools()) {
    check(toolRevealed(t, done, false), `ladder off: \`${t.id}\` is on the bar`);
  }
  // ...and with the ladder off, the cache key must be a constant, or a shop
  // that opted out rebuilds its palette every time a milestone ticks over.
  check(revealSig(new Set(['take-100']), false) === revealSig(new Set(), false),
    'ladder off: the cache signature does not move with the ladder');

  // A save that has never heard of the field is the second half of the same
  // control, and it is the one every existing shop is actually on.
  const g = fresh();
  check(g.reveal === false, 'a save with no `reveal` field reads as off',
    `got ${JSON.stringify(g.reveal)}`);
  check(g.snapshot?.().reveal === false || g.serialize().reveal === false,
    'and carries that off-ness outward');
}

// ---------------------------------------------------------------------------
// 2. THE CENTREPIECE: a gate may never be the thing it gates.
// ---------------------------------------------------------------------------
{
  for (const [tool, gate] of Object.entries(REVEAL)) {
    const m = byId[gate];
    check(!!m, `\`${tool}\` is gated on a milestone that exists`, `no rung "${gate}"`);
    if (!m) continue;

    // Named shapes first — cheap, and it is the check somebody reads when the
    // empirical one below fails and they want to know why.
    check(SAFE_GATES.some((p) => gate.startsWith(p)),
      `\`${tool}\` is gated on a rung of a safe shape`, `"${gate}" is not one`);

    // ...and then the real one. Stand the gated kind up in the shop and the
    // gating milestone's own measure must not budge. If it does, the button
    // arrives the moment it has stopped being needed.
    const g = fresh();
    const before = m.measure(g);
    const kind = FIXTURES[tool] ? tool : (GROUND_KINDS.includes(tool) ? tool : null);
    if (kind) {
      for (let i = 0; i < 30; i++) {
        g.placements.push({ id: `rv-${i}`, kind, x: 2 + (i % 8), z: 2 + Math.floor(i / 8), rot: 0, piece: kind });
      }
    }
    const after = m.measure(g);
    check(before === after,
      `\`${gate}\` does not measure \`${tool}\` — the gate is not the thing it gates`,
      `measure moved ${before} -> ${after}`);
  }
}

// ---------------------------------------------------------------------------
// 3. It gates, and it opens.
// ---------------------------------------------------------------------------
{
  const none = new Set();
  let gated = 0;
  for (const t of allTools()) {
    const gate = gateFor(t);
    if (!gate) {
      check(toolRevealed(t, none, true), `ungated \`${t.id}\` is on the bar from the first minute`);
      continue;
    }
    gated++;
    check(!toolRevealed(t, none, true), `\`${t.id}\` waits for \`${gate}\``);
    check(toolRevealed(t, new Set([gate]), true), `...and turns up when it lands`);
    // The rung that opens it is the ONLY rung that opens it: a shop that has
    // earned everything else must still be waiting.
    const others = new Set(MILESTONES.map((m) => m.id).filter((id) => id !== gate));
    check(!toolRevealed(t, others, true), `...and nothing else opens \`${t.id}\``);
  }
  check(gated >= 15, 'the table actually gates a meaningful share of the bar', `only ${gated}`);

  // Unlisted is visible, asserted of a kind that cannot ever be in the table.
  check(toolRevealed({ kind: 'zz-not-a-kind', id: 'zz-not-a-tool' }, none, true),
    'a tool nobody wrote a row for ships visible');
}

// ---------------------------------------------------------------------------
// 4. It is a ladder rather than a switch.
// ---------------------------------------------------------------------------
{
  const rungs = new Set(Object.values(REVEAL));
  check(rungs.size >= 3, 'the table spreads over several rungs',
    `everything arrives on ${[...rungs].join(', ')}`);

  // ...and the rungs are in a defensible order: whatever opens the conveyors
  // must not be the first thing a shop earns. `sold-500` is the rung the whole
  // feature is built around — the belt arriving once the tedium has been felt —
  // so it is named here on purpose. If it is retuned, this is supposed to fail.
  check(REVEAL.belt === 'sold-500', 'the belt still waits for five hundred sales',
    `got ${REVEAL.belt}`);
  check(gateFor({ kind: 'shelf' }) === null, 'a shelf is never gated');
  check(gateFor({ kind: 'checkout' }) === null, 'nor a till');
  check(gateFor({ kind: 'floor' }) === null, 'nor the floor brush');
}

// ---------------------------------------------------------------------------
// 4b. ...and nothing the TUTORIAL points at is gated.
//
// The card names a palette entry by selector, so a gated one is a step saying
// "pick the chiller out of the Shop tab" over a tab with no chiller in it. It
// does not crash — the veil has a third answer for a hole it cannot find — and
// it does not recover either, which is the worse of the two in the first five
// minutes of somebody's first shop.
//
// Written as an assertion rather than as a comment in the table because the
// near miss is what makes it dangerous: gating `freezer` behind `first-hire` is
// almost exactly right (the tutorial hires two beats earlier, on the identical
// predicate) and fails only on the race against a 1Hz milestone sweep. That is
// an intermittent tutorial bug, found by the people least able to name it.
// ---------------------------------------------------------------------------
{
  for (const kind of TUTORIAL_KINDS) {
    check(gateFor({ kind }) === null,
      `\`${kind}\` is never gated — the tutorial points at it`,
      `gated behind ${gateFor({ kind })}`);
    check(toolRevealed({ kind }, new Set(), true),
      `...so it is on the bar in a shop that has earned nothing`);
  }
}

// ---------------------------------------------------------------------------
// 4c. The table read BACKWARDS, which is what the card and the panel draw.
//
// `opensAt` is the only thing that turns a rung into words, so its failure mode
// is not a crash — it is an award card that says "prop-floor now on the build
// bar". A raw kind id reads as a debug string leaking into the one screen in the
// game whose whole job is to feel like a reward, and nothing anywhere would say
// so: the lookup succeeded, the row drew, the id is real.
// ---------------------------------------------------------------------------
{
  const seen = new Set();
  for (const m of MILESTONES) {
    const opens = opensAt(m.id);
    for (const word of opens) {
      // A label and never the key. `FIXTURES`/`GROUND` carry the words the bar
      // uses; anything without a row has to be named in `SHELL_WORDS`, and the
      // day somebody adds a gate for a kind with neither, this is what says so.
      check(!(word in REVEAL), `\`${m.id}\` opens a NAMED thing, not a raw kind`, `got "${word}"`);
      check(/^[A-Z]/.test(word), `...and it reads as a label`, `"${word}" is not capitalised`);
      seen.add(word);
    }
  }
  // Every gated tool is announced by exactly one rung — a tool named by none is
  // a button that appears with nothing having said it would.
  check(seen.size === Object.keys(REVEAL).length,
    'every gated tool is named by exactly one rung',
    `${Object.keys(REVEAL).length} gated, ${seen.size} named`);

  // ...and a rung that opens nothing says nothing, which is thirty-nine of the
  // forty-six. The caller draws no line at all rather than an empty one.
  check(opensAt('first-sale').length === 0, 'a rung that opens nothing answers empty');
  check(opensAt('zz-no-such-rung').length === 0, '...and so does one that does not exist');
  check(opensAt('sold-500').includes('Belt'), 'the belt rung names the belt');
}

// ---------------------------------------------------------------------------
// 5. A reveal is not a rule: the server places a gated kind regardless.
// ---------------------------------------------------------------------------
{
  const g = Game.create({ worldId: 'verify-reveal-place', seed: 'reveal', ephemeral: true });
  g.shell = null;
  g.ownedUpgrades = [];
  g.regenerateLayout(null, {}, { want: { shelf: 2, checkout: 1 } });
  g.freezeShell();
  g.freezeYard();
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true };
  // The ladder ON, and not one rung of it earned — so `belt` is a kind this
  // shop's own bar would not be drawing.
  g.reveal = true;
  g.milestones = { done: [], known: [] };
  g.cash = 999999;
  const before = g.placements.length;
  const res = g.placeFixture('me', { kind: 'belt', x: 6, z: 6, rot: 0 });
  check(g.placements.length > before,
    'a gated kind is still placeable with the ladder on — a reveal is not a permission',
    `placeFixture said ${JSON.stringify(res)}`);
}

// ---------------------------------------------------------------------------
// 6. Out and back, and switching off is not one-way.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const r = g.setReveal(true, 'sweep');
  check(r?.ok !== false && g.reveal === true, 'the switch moves');
  check(g.serialize().reveal === true, '...and survives `serialize`');
  check(g.saveState().reveal === true, '...and `saveState`');

  // The way home, which is the half that is never obvious — `paint` shipped
  // with only the outward leg for five steps and the `??` quietly wrote the
  // default back over what was stored.
  const back = Game.create({ worldId: 'verify-reveal', seed: 'reveal', ephemeral: true, });
  back.reveal = g.saveState().reveal ?? false;
  check(back.reveal === true, '...and comes back');

  // Off, then on again, with a rung earned in between: the bar you get back is
  // the bar you earned, not the opening one. This falls out of gating on
  // `milestones.done` rather than on a list of what has been shown, and that is
  // the whole reason there is no such list.
  const h = fresh(['take-100', 'first-hire']);
  h.setReveal(false, 'sweep');
  h.milestones.done.push('sold-500');
  h.setReveal(true, 'sweep');
  const done = new Set(h.milestones.done);
  check(toolRevealed({ kind: 'belt' }, done, true), 'a rung earned while off still counts when back on');
  check(toolRevealed({ kind: 'plot' }, done, true), '...and so do the ones earned before');
  check(!toolRevealed({ kind: 'sorter' }, done, true), '...while what was never earned is still to come');

  // Same value twice is a no-op rather than a second log line.
  const again = h.setReveal(true, 'sweep');
  check(again?.ok !== false, 'setting it to what it already is is fine');
}

// ---------------------------------------------------------------------------
// 8. THE OTHER END OF THE TABLE: a piece that is no longer offered.
//
// `RETIRED_PIECES` is the gate table's opposite promise — a gate hides a button
// you have not reached, this takes away one you have gone past — and its claim
// is a PAIR that is worthless split in half. The piece must be off the bar AND
// must still resolve, and each half alone is satisfied by the wrong fix.
//
// Off the bar alone is satisfied by deleting the row, which is the thing this
// mechanism exists so that nobody does: `pieceFor` falls through to
// `defaultPiece` for a piece it cannot find, and `defaultPiece` answers the
// first row of the kind — so a deleted `hen-house` does not empty the hen
// houses standing in seven live shops, it silently turns every one of them into
// whatever pen row sorts first. They go on filling, nothing errors, nothing is
// logged, and what you are looking at is a farm that is suddenly all one
// building. **It reads as art**, which is why it would survive a screenshot and
// why the claim is written here rather than trusted to the next person.
//
// And still-resolves alone is satisfied by never having retired anything at
// all, which is the control below.
//
// What this canNOT reach is the filter itself — `client/sections.js` pulls the
// audio manifest, so `computeBuildTools` will not load in node, exactly as
// section 1's header says of the cache key. So the PREDICATE is asserted, which
// is why `pieceOffered` is a function rather than a bare lookup, and the two
// things left uncovered are named at that call site: the `drawn`/`mine` split
// that keeps a fully retired kind from falling back to its own bare button, and
// removal-rather-than-flagging.
// ---------------------------------------------------------------------------
{
  const rows = content().fixtures ?? [];
  const ids = Object.keys(RETIRED_PIECES);

  // The control, and it is the one that decides whether any of this is opt-in:
  // a piece nobody retired is offered, which is every row in the catalogue bar
  // these. Unlisted is VISIBLE here for the same reason it is above — a piece
  // authored tomorrow must turn up on the bar, where a default of hidden is a
  // fixture that prices, places, renders and can never be found.
  for (const p of rows) {
    if (RETIRED_PIECES[p.id]) continue;
    check(pieceOffered(p.id), `\`${p.id}\` is still offered`);
  }
  check(pieceOffered('zz-authored-tomorrow'), 'a piece nobody has heard of is offered');

  for (const id of ids) {
    // Half one: off the bar.
    check(!pieceOffered(id), `\`${id}\` is no longer offered`);

    // Half two: and still resolves to ITSELF. Asked through `pieceFor` with the
    // shape a placement actually carries, because that is the call every live
    // shop makes on every re-flow — and `defaultPiece`'s forgiveness means a
    // missing row answers a *different* piece rather than null, so a test for
    // truthiness would pass on exactly the failure this is about.
    const row = rows.find((p) => p.id === id);
    check(!!row, `\`${id}\`'s row is still in the catalogue`, 'deleted, not retired');
    if (!row) continue;
    const got = pieceFor(rows, { kind: kindOf(row), piece: id });
    check(got?.id === id, `...and a placement of it still resolves to itself`,
      `got ${got?.id ?? 'null'}`);
    // The three things a live placement is drawn, priced and run from. A row
    // that survived with its art stripped is the same silent failure one field
    // along.
    check(got?.model != null || (got?.bodies?.length ?? 0) > 0,
      `...and keeps its art`);
    check(Array.isArray(got?.tiers) && got.tiers.length >= 1, `...and its tier ladder`);
    check(got?.produces?.item_id, `...and goes on producing what it always did`,
      `produces ${JSON.stringify(got?.produces ?? null)}`);
  }

  // A retirement is not a permission, which is the header's claim said as a
  // value: the server must still place one. Same argument section 5 makes about
  // a gate, and the same four callers — MCP, this sweep, the balance bot and a
  // co-op guest a version ahead.
  if (ids.length) {
    const g = Game.create({ worldId: 'verify-reveal-retired', seed: 'reveal', ephemeral: true });
    g.shell = null;
    g.ownedUpgrades = [];
    g.regenerateLayout(null, {}, { want: { shelf: 2, checkout: 1 } });
    g.freezeShell();
    g.freezeYard();
    silenceMilestones(g);
    g.addPlayer('me', 'Tester');
    g.players.me.build = { on: true };
    g.cash = 999999;
    const row = rows.find((p) => p.id === ids[0]);
    const kind = kindOf(row);
    // Cleanly, or the first cell of the sweep is the corner of the map and the
    // claim below is about a placement nobody could have reached anyway —
    // `verify:pens` makes the same call for the same reason.
    let spot = null;
    const L = g.layout;
    for (let z = 1; z < L.h - 1 && !spot; z++) {
      for (let x = 1; x < L.w - 1 && !spot; x++) {
        for (const rot of [0, 1, 2, 3]) {
          if (canPlaceCleanly(L, { kind, x, z, rot }).ok) { spot = { x, z, rot }; break; }
        }
      }
    }
    const before = g.placements.length;
    const res = spot ? g.placeFixture('me', { kind, piece: ids[0], ...spot }) : null;
    check(g.placements.length > before,
      'the server still builds a retired piece — this is a filter, not a rule',
      `placeFixture said ${JSON.stringify(res)}`);
    // ...and it resolves to the retired row rather than to a shipped pen, which
    // is section 8's whole claim arriving through the one door a player uses.
    const built = g.placements.find((p) => p.piece === ids[0]);
    check(!!built && g.fixtureContent(built)?.id === ids[0],
      '...and what it built is that piece and not the kind default',
      `got ${g.fixtureContent(built)?.id ?? 'nothing'}`);
  }
}

// ---------------------------------------------------------------------------
console.log(`verify:reveal — ${checks} checks`);
if (failures.length) {
  console.error(`\n${failures.length} FAILED:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('all good');
