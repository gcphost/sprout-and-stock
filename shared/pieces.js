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

import { PROP_KINDS } from './build.js';

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
 * How the fixture ledger names one of these.
 *
 * Three namespaces in one table, and the split is not cosmetic — it follows
 * from what the ledger is *for*, which is the generator's shopping list.
 *
 * - A tile fixture keys by KIND, because `regenerateLayout` hands the generator
 *   `shelves: fixtures.shelf` and it has to place one per unit owned. Key a
 *   second shelf design separately and the budget it needs is never asked for,
 *   so the placement is dropped the next time the shop re-flows.
 * - An appliance keys by machine, because a blender is not a toaster and the
 *   generator needs the list by name to put the right one back.
 * - A prop keys by PIECE, because nothing procedural ever places one: a prop
 *   exists only where somebody put it, so its count is free to mean what you
 *   would expect it to mean.
 */
export function ledgerKey(kind, { station = null, piece = null } = {}) {
  if (kind === 'station') return `station:${station}`;
  if (PROP_KINDS.includes(kind)) return `prop:${piece || kind}`;
  return kind;
}
