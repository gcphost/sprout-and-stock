/**
 * WHAT A BREAK LOOKS LIKE.
 *
 * Step 8 gave workers breaks and left them standing at the spot in exactly the
 * pose they work in — so a hire who had downed tools was indistinguishable from
 * one who was busy, and the only place that said otherwise was their menu. This
 * is the other half: a prop, and some motion.
 *
 * The split is the same one the rest of the game uses.
 *
 *   AUTHORED — the prop itself, in the pastime's `model`, staged by how far
 *   through the break they are. `partsAt(model, breakProgress)` and a mug
 *   empties, a sandwich goes down to the crusts, a cloud builds and thins. No
 *   code in here knows what a mug is.
 *
 *   CODE — everything continuous. State arrives at 10Hz and the page draws at
 *   60, so anything that only moved when the snapshot did would read as a
 *   rendering fault (the same argument the `liftedRing` comment makes). The
 *   slump, the breathing, the bob of whatever is in their hands and the rise
 *   and fade of a puff all happen per frame, driven by the clock.
 *
 * The one thing stages genuinely cannot say is a loop: a stage arc plays once
 * across a twenty-second break, and smoke has to keep going. That is what a
 * part flagged `drift` is for, and it is the whole reason the flag exists.
 */

import * as THREE from 'three';
import { buildModel, material } from './props.js';
import { partsAt } from '../../shared/model.js';

/** Radians the body tips onto one hip while resting. */
const LEAN = 0.2;
/** How fast the slump eases in and out, per frame. */
const SETTLE = 0.07;
/** Close enough to the target to stop easing and sit still. */
const SETTLED = 0.004;

/** Seconds for one rise-and-fade of a drifting part. */
const PUFF_SECONDS = 2.4;
/** How far a puff climbs over one cycle, in tiles. */
const PUFF_RISE = 0.5;
/** How opaque a puff is when it leaves them. It thins to nothing from here. */
const PUFF_ALPHA = 0.8;
/**
 * Steps a puff's fade is quantised to.
 *
 * Opacity has to be per-puff, and `material()` hands out ONE cached material
 * per colour — so tinting it would fade every prop in the shop that happened to
 * share the colour. Cloning per mesh would work and would then have to be
 * disposed, which `disposeGroup` deliberately doesn't do. Quantising instead
 * means the fade is ten shared materials that outlive the break, which is the
 * same trick `setGrowthBar` uses to swap between two.
 */
const FADE_STEPS = 10;

/**
 * The prop for one pastime, at one point through the break.
 *
 * Split in two at build time because the halves move differently: the held
 * parts ride with the worker, and each drifting part needs its own transform to
 * climb on. Both come out of one authored model — which half a part is in is
 * the `drift` flag and nothing else.
 */
export function buildPastimeProp(model, t = 0) {
  const g = new THREE.Group();
  const parts = partsAt(model, t);
  if (!parts.length) return g;

  // Nothing on a person casts a shadow here — the body already does, and a mug
  // laying its own shadow across the floor from chest height reads as litter.
  const held = buildModel({ parts: parts.filter((p) => !p.drift) }, { castShadow: false });
  g.add(held);

  const puffs = [];
  for (const part of parts.filter((p) => p.drift)) {
    const base = part.pos ?? [0, 0, 0];
    // Built at the origin and *moved* there, rather than built where it was
    // authored. A puff swells as it climbs, and scaling a group scales its
    // children's offsets too — so a cloud authored out at the mouth would sail
    // off sideways as it grew instead of rising off the spot it was drawn on.
    const obj = buildModel({ parts: [{ ...part, pos: [0, 0, 0] }] }, { castShadow: false });
    obj.position.set(base[0], base[1], base[2]);
    g.add(obj);
    puffs.push({
      obj,
      base,
      mesh: obj.children[0] ?? null,
      color: part.color,
      // What it's worth at the bottom of its climb. A drifting part's opacity is
      // rewritten every frame, so without this its authored `alpha` would be a
      // field that quietly did nothing — thin vapour and thick would look the same.
      alpha: part.alpha ?? 1,
      // Spread so a bank of them doesn't pulse in lockstep. Fractional, and
      // folded into absolute time below, so a rebuild at a stage boundary
      // picks the cycle up where it left off instead of snapping to the start.
      phase: (puffs.length * 0.37) % 1,
    });
  }

  g.userData.held = held;
  g.userData.puffs = puffs;
  return g;
}

/**
 * One actor, one frame.
 *
 * Everything here is driven by `now` rather than by the snapshot, and everything
 * eases rather than switching, so going on a break and coming back off one are
 * both a movement instead of a jump cut.
 *
 * `rec` is a `syncActors` record: `obj` is the body, `resting` says whether they
 * are on a break, `pastime` is the prop if the pastime has one authored, and
 * `slump` is our own eased 0..1 that we keep on it.
 */
export function animateRest(rec, now) {
  const want = rec.resting ? 1 : 0;
  const at = rec.slump ?? 0;
  const slump = Math.abs(want - at) < SETTLED ? want : at + (want - at) * SETTLE;
  rec.slump = slump;
  // Upright, empty-handed and not on the way anywhere — which is every shopper
  // in the shop and every worker who is working, so it wants to be the cheap case.
  if (!slump && !rec.pastime) return;

  const t = now / 1000;
  const phase = rec.phase ?? 0;
  const breath = Math.sin(t * 1.7 + phase);

  // The body. This is the half that reads from across the shop: at this camera
  // a mug is a few pixels, but a silhouette that has stopped standing to
  // attention is obvious even out of focus. `rotation.y` is the facing and is
  // rewritten every sync — these two axes are ours alone.
  rec.obj.position.y = (breath * 0.028 - 0.035) * slump;
  rec.obj.rotation.z = (LEAN + breath * 0.045) * slump;
  rec.obj.rotation.x = breath * 0.02 * slump;

  const g = rec.pastime;
  if (!g) return;

  // Whatever is in their hands, given a life of its own so a mug tips toward
  // them rather than being welded to their chest.
  g.userData.held.rotation.x = Math.sin(t * 1.1 + phase) * 0.16;
  g.userData.held.position.y = Math.sin(t * 2.3 + phase) * 0.012;

  for (const puff of g.userData.puffs) {
    const cycle = (t / PUFF_SECONDS + puff.phase) % 1;
    puff.obj.position.y = puff.base[1] + cycle * PUFF_RISE;
    puff.obj.position.x = puff.base[0] + Math.sin(cycle * 5 + puff.phase * 6) * 0.06;
    // Spreading as it climbs is most of what makes it read as vapour rather
    // than as a ball going up.
    puff.obj.scale.setScalar(0.65 + cycle * 1.1);
    if (puff.mesh) puff.mesh.material = fade(puff.color, 1 - cycle, puff.alpha);
  }
}

/** A shared, quantised, translucent material — see FADE_STEPS. */
function fade(color, k, peak) {
  const step = Math.max(1, Math.round(Math.min(1, Math.max(0, k)) * FADE_STEPS));
  // Rounded, or the cache key is a float like 0.08000000000000002 and every
  // frame mints a material nobody will ever hit again.
  return material(color, Math.round((step / FADE_STEPS) * PUFF_ALPHA * peak * 100) / 100);
}
