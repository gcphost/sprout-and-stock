/**
 * WHAT A PIECE LOOKS LIKE STANDING ON ITS OWN — asked once, by everything that
 * has to show you a thing before it exists.
 *
 * Three places draw a piece you have not built yet: the palette button
 * (`thumb.js`), the ghost under the pointer, and the ghost of a dragged run or
 * a pasted blueprint. Each of them resolved its own model — `variantModel`,
 * `partsAt`, done — which is right for every piece whose row is the whole story
 * and silently wrong for the ones where the renderer overrules it. There is no
 * error and nothing to notice: the row validates, the model resolves, the
 * preview renders, and what lands is a different object.
 *
 * `lift` is the case that made this worth a file. `conveyorBody` opens with
 * `if (f.kind === 'lift') body = []` and assembles the housing in code out of
 * `elevator.js`, so its row is the one model in the catalog nothing draws — and
 * all three previews went on showing the four-post tower the glazed cabinet
 * replaced. Fixed in one place three times over is how it stays fixed once.
 *
 * WHAT THIS IS NOT is the shop's answer. A standing fixture's art depends on
 * what is plumbed into it — `conveyorBody` trims a corner's deck to the legs
 * that exist, an elevator's walls are windows or doorways depending on which
 * sides are connected, a machine under a duct has its cap cut open. None of
 * that can be asked of a piece under the pointer, because it has no neighbours
 * yet. So this answers the STANDALONE case deliberately, which is also the
 * honest one for a preview: it is what you get for your money the moment you
 * press, before anything is joined to it.
 *
 * Nothing in here imports three.js, and that is load-bearing twice: `thumb.js`
 * is one of the callers and `scripts/build-favicon.js` runs it in node.
 */

import { partsAt, variantModel } from '../../shared/model.js';
import { liftParts } from './elevator.js';

/**
 * The parts a piece is drawn from with nothing attached to it, at `t`.
 *
 * `spec` is whatever names the thing — a placement, or a palette entry's
 * `{kind, variant}`. `t` is the piece's own 0..1, which the caller owns because
 * the three of them spend it differently: a button draws stage 0 ("what you get
 * for your money"), a watcher draws the shop's signal instead, and a ghost
 * draws the tier being placed.
 *
 * Returns `null` for a piece with no model at all, which is the answer every
 * caller already handled.
 */
export function standaloneParts(piece, spec = {}, t = 0) {
  // A lift's row is never opened by the renderer — see the header — so the one
  // honest picture of one comes from the same constants the shaft is built out
  // of. Ahead of the model lookup rather than after it: the row HAS a model,
  // and a lookup that succeeds is exactly why this went unnoticed.
  if (spec.kind === 'lift') return liftParts(spec.tier ?? 1);
  // `||`, not `??`: an unstyled fixture carries `variant: ''` rather than
  // nothing, and an empty string is a perfectly good value as far as `??` is
  // concerned — which quietly hands every appliance the generic model back.
  const variant = spec.variant || (spec.kind === 'station' ? spec.station : null);
  const model = variantModel(piece, variant);
  return model ? (partsAt(model, t) ?? null) : null;
}
