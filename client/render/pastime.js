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
 *
 * That half now lives in render/motion.js, because an appliance mid-batch wants
 * exactly the same thing and two copies of a puff is two things that drift
 * apart. What is left in here is what is actually about a person: the slump,
 * the breathing, and the tip of whatever is in their hands.
 */

import { buildLoopingProp, animatePuffs, animateMotion } from './motion.js';
import { partsAt } from '../../shared/model.js';

/** Radians the body tips onto one hip while resting. */
const LEAN = 0.2;
/** How fast the slump eases in and out, per frame. */
const SETTLE = 0.07;
/** Close enough to the target to stop easing and sit still. */
const SETTLED = 0.004;

/**
 * The prop for one pastime, at one point through the break.
 *
 * Nothing on a person casts a shadow — the body already does, and a mug laying
 * its own shadow across the floor from chest height reads as litter.
 */
export function buildPastimeProp(model, t = 0) {
  return buildLoopingProp(partsAt(model, t), { castShadow: false });
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

  animatePuffs(g.userData.puffs, t);
  // A pastime is never idle — somebody is either on a break or they are not,
  // and the prop only exists for as long as they are. So a `motion` part of one
  // simply runs: a phone screen that pulses, a fan somebody is holding.
  animateMotion(g.userData.moving, t, true);
}
