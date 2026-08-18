/**
 * PIECES — the catalog half of building.
 *
 * `shared/build.js` owns the closed set of KINDS: where a thing may go, whether
 * it blocks, which side you use it from. This file owns the open set of PIECES:
 * rows in the `fixtures` table, each naming a kind and carrying its own model,
 * variants and tier ladder.
 *
 * It is the same split `JOBS` made for workers, and for the same reason. A job
 * name is a function in the sim, so the vocabulary is closed and a worker who
 * names one that nobody implemented is rejected at the gate rather than standing
 * still forever. A kind is a set of placement rules, so the vocabulary is closed
 * and a piece naming an unknown one is rejected the same way — while the number
 * of pieces naming a known kind stays unlimited, which is what makes a second
 * shelf design, a planter or a hanging lamp an MCP call instead of a deploy.
 *
 * Shared because both sides resolve the same piece for the same fixture: the
 * server to price and place it, the client to draw it and to colour the ghost.
 * Two copies of "which design is this" is two shops that disagree about what
 * is standing in them.
 */

import { surfacesAt, tierProgress } from './model.js';
import { FIXTURES } from './build.js';

/** Every piece of one kind, in catalog order. */
export function piecesOf(rows, kind) {
  return (rows ?? []).filter((p) => kindOf(p) === kind);
}

/**
 * What kind a row is.
 *
 * A row written before the split has no `kind` and *is* its kind — that is
 * exactly what "fixtures.id is the kind" meant. Read here rather than migrated
 * in the database so an old save, an old export and a fresh seed all agree
 * without anyone having to run anything.
 */
export const kindOf = (row) => row?.kind || row?.id || null;

/**
 * The piece a kind falls back to when nothing chose one.
 *
 * The row whose id *is* the kind first, because that is the row every existing
 * fixture was drawn from — so every shelf standing in every shop keeps the
 * design it already had, with no migration and no visible change on the day
 * this landed. Failing that the first piece authored for the kind, so a kind
 * whose own row was deleted still draws as something.
 */
export function defaultPiece(rows, kind) {
  const mine = piecesOf(rows, kind);
  return mine.find((p) => p.id === kind) ?? mine[0] ?? null;
}

/**
 * Which piece a placed fixture is drawn and priced from.
 *
 * A piece that has since been deleted falls back to the kind's default rather
 * than to nothing — the same forgiveness `fixtureTier` shows a tier ladder that
 * got shorter, and for the same reason: content is edited live, and a fixture
 * standing in a shop should not vanish because somebody tidied the catalog.
 */
export function pieceFor(rows, f) {
  if (!f) return null;
  const want = f.piece;
  if (want) {
    const hit = (rows ?? []).find((p) => p.id === want && kindOf(p) === f.kind);
    if (hit) return hit;
  }
  return defaultPiece(rows, f.kind);
}

/**
 * What to call a placed fixture *out loud* — "Bakery Case", "Blender", "Plot".
 *
 * The name a player sees has to come off the same catalog row the picture does,
 * for the reason `client/thumb.js` gives about buttons: a second place that
 * says what a thing is called is a second thing to keep in step, and the one
 * that drifts is always the one nobody is looking at. Which is exactly what
 * happened — every log line about a fixture printed its *id* (`Sowed tomato
 * vine in fx2`), because a plot is a record with an id and no name on it, and
 * `fx2` is a fact about the save file rather than about the shop.
 *
 * Three answers, in order of how much they know:
 *
 * - the piece's own name, which is the whole point of the kinds/pieces split.
 *   A Bakery Case called "Shelf" is the same wrong answer as a Bakery Case
 *   drawn as one.
 * - an appliance by the machine it is, because `station` is one catalog row
 *   covering every machine — a blender is not a toaster, and `countKey` makes
 *   the same exception for the same reason.
 * - the kind's label, for a record whose design was deleted out from under it,
 *   and `'fixture'` for one that names no kind at all. Never the id.
 *
 * Cased for the start of a sentence. Callers writing "the …" lowercase it, the
 * way `shared/build.js` already does with `FIXTURES[kind].label`.
 */
export function fixtureLabel(rows, f) {
  if (!f) return 'Fixture';
  if (f.kind === 'station' && f.station) {
    const words = String(f.station).replace(/-/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return pieceFor(rows, f)?.name || FIXTURES[f.kind]?.label || 'Fixture';
}

/**
 * How a count of these is named — to the palette, and over the wire.
 *
 * `ledgerKey` used to live here and had to answer this three different ways.
 * A tile fixture keyed by KIND, because `world.fixtures` doubled as the
 * generator's shopping list and `regenerateLayout` handed it `shelves:
 * fixtures.shelf`: key a second shelf design under its own name and the budget
 * it needed was never asked for, so the placement was dropped on the next
 * re-flow, silently, one at a time. A prop keyed by PIECE, because nothing
 * procedural ever places one and there was no budget to protect. That asymmetry
 * was load-bearing for exactly as long as the ledger was.
 *
 * Step 9 retired the ledger — a stamped shop *is* its placements, so the count
 * is a recount (`Game.fixtureCounts`) and nothing is asked of the generator any
 * more. So this can be the one obvious rule: a thing is counted as the design it
 * is, and an appliance as the machine it is, because a blender is not a toaster
 * and no catalog row tells them apart yet.
 */
export function countKey(kind, { station = null, piece = null } = {}) {
  return kind === 'station' ? `station:${station}` : (piece || kind);
}

/**
 * How many DIFFERENT things one unit can hold at once — its boards.
 *
 * Read off the art rather than authored, the same argument `surfacesAt` itself
 * makes and the same one `seamStep` makes about which side a panel closes: a
 * three-board shelving unit is *drawn* as three places goods can sit, and a
 * second field saying "…and it holds three kinds" is a number that can quietly
 * disagree with the picture. Nobody has to author anything for this, and
 * `docs/fixtures.md` has been printing the count per piece since the day it was
 * generated — it simply meant nothing before.
 *
 * Read at THIS fixture's tier, not at the top of the ladder, because a staged
 * model can grow a board as it climbs: the shipped `freezer` draws 2, 2, 3 and
 * `produce-table` 2, 3, 3. So an upgrade can now buy you another kind, which is
 * a tier changing a number the sim reads — exactly what a tier is for, and the
 * reason a tier that changes none is called out as a button that takes money
 * and does nothing.
 *
 * Anything with no boards answers 1 rather than 0. A chest freezer and a
 * counter pile goods on the roof, which is one heap and therefore one kind —
 * zero would mean a unit that can hold nothing, which is not a fixture, it is
 * a decoration.
 */
export function boardsOf(rows, f) {
  const piece = pieceFor(rows, f);
  if (!piece?.model) return 1;
  const ladder = piece.tiers?.length ?? 1;
  const tier = Math.min(Math.max(1, Math.trunc(f?.tier ?? 1)), ladder);
  return Math.max(1, surfacesAt(piece.model, tierProgress(tier, ladder)).length);
}

/**
 * What a laid floor is made of.
 *
 * The `model` lookup's opposite number, and it needs its own because a floor is
 * the one piece with no model: it is not a thing standing in a cell, it *is*
 * the cell, so what content authors is a colour and a repeat.
 *
 * Falls back to plain shop floor rather than to nothing, which is the same
 * forgiveness `pieceFor` shows a deleted design and matters more here — a
 * floor row tidied out of the catalog while a shop is standing on it would
 * otherwise render as a black hole across half the building.
 *
 * It rebuilds the object field by field rather than spreading the row, and that
 * is the trap: every field a pattern needs has to be named here or it is
 * authored, validated, printed in `docs/fixtures.md` and silently dropped on
 * the way to the renderer. `bars` was exactly that from the day it shipped —
 * `stripeBars` reads `surface.bars`, which was never on the object it was
 * handed, so every crossing in the game was drawn at the default three however
 * it was authored. A number that goes nowhere is the "tier that changes no
 * number" trap wearing a surface.
 */
export function surfaceOf(rows, pieceId, fallbackColor) {
  const row = (rows ?? []).find((p) => p.id === pieceId);
  const s = row?.surface;
  const bare = { color: fallbackColor, accent: null, pattern: 'plain', bars: null, density: null, blade: null };
  if (!s?.color) return bare;
  return {
    color: s.color,
    accent: s.accent ?? null,
    pattern: s.pattern ?? 'plain',
    bars: s.bars ?? null,
    density: s.density ?? null,
    blade: s.blade ?? null,
  };
}
