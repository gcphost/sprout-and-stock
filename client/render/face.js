/**
 * WHAT A FACE IS DOING.
 *
 * A shopper's head has had a face on it since `characterParts` grew one —
 * sclera, pupils, brows and a mouth, seven boxes — and until now the only thing
 * that ever moved was the COLOUR: `animateMoods` flushes the head from cream to
 * red as somebody's patience runs out. That is one tell, it is the tell people
 * with the commonest form of colour blindness can least read, and it is doing
 * the work of an expression while the face sits perfectly still underneath it.
 * The brows' own authoring comment said so — "capable of an expression at all,
 * so they are here even though nothing animates them yet". This is that.
 *
 * Two things happen here and they are deliberately unconnected:
 *
 *   ALIVE — a blink, on a per-person clock. It says nothing about the shop and
 *   is not meant to; a crowd of faces that never blink is the thing that makes
 *   a still frame of them read as mannequins.
 *
 *   MOODY — the brows and the mouth, off the number the sim already keeps. A
 *   cross shopper scowls and a delighted one grins, which is the anger tell
 *   said a second way and is the first thing on a body that says somebody is
 *   HAPPY at all.
 *
 *
 * WHY THIS IS POSSIBLE AT ALL, AND ONLY HERE
 *
 * A batched body's parts are separate instances with a local matrix each
 * (`crowdLocals`), and — the load-bearing half — that array is built **per
 * body** in `crowdBody` rather than cached per look. So writing an eyebrow's
 * matrix moves one shopper's eyebrow. If it were ever shared, the first cross
 * shopper in the shop would scowl on behalf of everybody wearing their haircut.
 *
 * The mesh path cannot do any of this and is not made to. `buildCharacter`
 * WELDS `trim` into one object, which is what keeps forty shoppers from being a
 * hundred and twenty draws — so a face there is a single mesh with the brows
 * baked into its vertices. That path draws thumbnails, first person and the
 * overflow when the batch is full, and a face that does not blink in a 38px
 * roster tile is not a thing anybody will ever notice.
 *
 *
 * WHY IT IS QUANTISED
 *
 * `FACE_RAMP` is eight shades rather than a lerp because `material()` caches by
 * colour and a continuous ramp would mint one per shopper per frame. This is
 * the same argument pointed at arithmetic instead of at memory: an expression
 * that moved every frame would recompose seven matrices per body per frame for
 * a face that is about eight pixels tall, and a mood drifts by a thousandth a
 * tick. So the expression is rounded to `STEPS` and the blink to four stages,
 * and a body whose face has not *changed* costs one integer compare.
 */

import * as THREE from 'three';

/**
 * How many expressions there are between a scowl and a grin.
 *
 * Odd on purpose: an even count has no middle, and the middle is the face
 * every single person in the shop wears nearly all of the time.
 */
const STEPS = 9;

/** Seconds between blinks, before the per-person spread below. */
const BLINK_EVERY = 4.4;
/** ...and how much of that spread there is. A shop that blinks in time is worse
 *  than one that never blinks: unison is the one thing a crowd cannot do. */
const BLINK_SPREAD = 2.6;
/** How long the lids are down. A real blink is about this and reads as a snap. */
const BLINK_TIME = 0.14;

/**
 * The mood at which somebody is doing neither.
 *
 * `MOOD_ANNOYED` in the sim, and the same 0.5: below it `angerOf` starts
 * counting and the head starts going red, so continuing the same number UPWARD
 * is what makes the grin the other half of one scale rather than a second
 * opinion about the same shopper. Restated rather than imported because the sim
 * does not export it — and if it ever moves, a face that disagreed with the
 * flush by a hair would read as art rather than as a constant.
 */
const NEUTRAL = 0.5;

/** Scratch, for the reason `CROWD_M4` is: this runs thousands of times a second. */
const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const P = new THREE.Vector3();
const S = new THREE.Vector3();

/**
 * One body's face, one frame.
 *
 * `rec` is a `syncActors` record. Everything it reads is already on there —
 * `anger` and `mood` are stashed by the sync, `phase` is the per-person hash
 * that already keeps two hires from breathing in time — and everything it
 * writes is `c.locals`, which `flushCrowd` multiplies out a few lines later.
 *
 * A body with no batch (an authored hire, or the mesh fallback) costs one
 * property read and returns.
 */
export function animateFace(rec, now) {
  const c = rec.obj?.userData?.crowd;
  const face = c?.desc?.face;
  if (!face || face.mouth < 0) return;

  const t = now / 1000;
  const step = Math.round(cheerOf(rec) * (STEPS - 1));
  const lid = blinkAt(t, rec.phase ?? 0);
  // The whole of what makes this cheap. A face is eight pixels tall and a mood
  // moves by a thousandth a tick, so nearly every frame for nearly every body
  // in the shop ends here.
  const sig = step * 8 + lid;
  if (rec.faceSig === sig) return;
  rec.faceSig = sig;

  // -1 scowling, 0 neutral, +1 grinning, off the rounded step rather than off
  // the raw number — or the rounding above would be a lie about what is drawn.
  const e = step / (STEPS - 1) * 2 - 1;
  const shut = lid / 3;

  for (let i = 0; i < 2; i++) {
    // `s` is which side of the face this is, and it is read off the authored
    // position rather than off the loop counter: the brows are authored with a
    // sign already in their rotation, and a second opinion about which one is
    // the left is how you get one eyebrow doing the opposite of the other.
    const s = Math.sign(c.desc.parts[face.brows[i]].position[0]) || 1;

    /*
     * The brow. Three things at once, because one alone is not an expression:
     * an ANGLE, a HEIGHT (a lowered brow is most of what makes a scowl read at
     * distance), and a PINCH inward, which is the one that turns "cross" into
     * "cross at you".
     *
     * The angle is the half that is not symmetric, and getting it wrong looks
     * *correct* — which is why it is written as two one-sided terms rather than
     * as one signed one. The art is authored outer-end-DOWN (rot z ∓0.16),
     * which is a faintly concerned resting face. Scowling means driving the
     * inner end down, so the sign has to REVERSE and overshoot; beaming means
     * raising the brows and FLATTENING them, and the 0.16 is exactly what
     * cancels the authored slope at full grin. Carry on through zero instead
     * and a delighted shopper gets the same slope twice as steep, which is a
     * pleading face — the one expression on the scale nobody asked for, worn by
     * everybody having a nice time.
     *
     * Added to the authored rotation rather than replacing it, so the default
     * the art was drawn with survives untouched at neutral.
     */
    write(c, face.brows[i], {
      dy: e * 0.016,
      dx: -s * Math.max(0, -e) * 0.006,
      rz: s * (Math.max(0, -e) * 0.34 + Math.max(0, e) * 0.16),
    });

    /*
     * The eye. Blinking is the only thing that moves it, and it is a SQUASH
     * about the eye's own centre rather than a lid coming down, because there
     * is no lid — the sclera flattening to a line and the pupil flattening
     * with it is what a closed eye is made of when your whole face is seven
     * boxes.
     *
     * The pupil is left wider than the white and shrinks less, so what is on
     * screen at the bottom of a blink is a dark line rather than a cream one.
     * A closed eye is a crease, and a crease is dark.
     */
    write(c, face.eyes[i], { sy: 1 - shut * 0.92 });
    write(c, face.pupils[i], { sy: 1 - shut * 0.78, sx: 1 + shut * 0.35 });
  }

  /*
   * The mouth, which is one box and therefore cannot curve.
   *
   * So it does the two things a bar can do and they turn out to be enough at
   * this size: it gets WIDER and drops a little to grin, and it pulls in and
   * thickens to a tight line to scowl. Width is what carries it — a mouth that
   * runs most of the width of the face reads as open and pleased from across
   * the shop, where a thin one reads as pressed shut.
   *
   * Two boxes at an angle would make a real smile and it is deliberately not
   * done: they would have to cross at the middle to avoid a gap, and a V of
   * two bars on a face this size is a beak.
   */
  write(c, face.mouth, {
    sx: 1 + Math.max(0, e) * 0.75 - Math.max(0, -e) * 0.32,
    sy: 1 + Math.max(0, -e) * 0.5,
    dy: e * -0.006,
  });
}

/**
 * 0 to 1, from the two numbers the sim already sends and whatever the arms are
 * doing about it.
 *
 * One scale with `MOOD_ANNOYED` in the middle of it, so the flush and the face
 * are the same fact about the same shopper said twice: below the line `anger`
 * counts down from the sim's own arithmetic and above it `mood` counts up. It
 * is deliberately not an average of the two — `anger` IS a function of `mood`,
 * so averaging them would be one number weighted against itself.
 *
 * Somebody with no mood at all — you, and every hire — sits at neutral and only
 * ever blinks. That is right rather than a shortfall: patience is a shopper's
 * resource, and a shopkeeper whose face reported one would be showing a number
 * that does not exist.
 */
function cheerOf(rec) {
  const base = moodOf(rec);
  // ...and then whatever their arms are doing overrules it, which is the one
  // input here that is not the shop's opinion of them. It is a BLEND on the
  // pose's own envelope (`emoteAmount`, written a few lines earlier by
  // `animateEmote`) rather than a switch, so the grin arrives with the arm and
  // leaves with it — a face that snapped to happy and back would be two
  // animations on one body disagreeing about when the emote started.
  //
  // Blended rather than added, so it cannot be beaten: somebody halfway to
  // storming out still grins while they wave back, because they are waving
  // back. That is the right way round — an emote is a thing somebody CHOSE to
  // do, and a scowl showing through it would read as the wave not having
  // registered.
  const grin = GRIN[rec.emote] ?? 0;
  const amount = grin * (rec.emoteAmount ?? 0);
  return base + (1 - base) * amount;
}

/**
 * How pleased each pose is, 0 to 1.
 *
 * Three of the four are, and `point` deliberately is not: it means "that one,
 * over there", which is a thing you do with a straight face, and a shopkeeper
 * beaming while they point at a shelf reads as sarcasm. It is a table rather
 * than a flag on the emote itself for the reason `shared/emotes.js` gives about
 * `signal`: how happy a pose looks is a fact about the ART, so it belongs next
 * to the art and not in the vocabulary the server validates against.
 */
const GRIN = { wave: 0.85, cheer: 1, dance: 1, point: 0 };

/** The half of it that IS the shop's opinion — see above. */
function moodOf(rec) {
  if (rec.anger > 0) return (1 - rec.anger) / 2;
  if (rec.mood == null) return 0.5;
  const up = Math.min(1, Math.max(0, (rec.mood - NEUTRAL) / (1 - NEUTRAL)));
  return 0.5 + up / 2;
}

/**
 * Which of four lid stages this person is on right now.
 *
 * Off `phase`, which is the same per-person hash their breathing and their
 * separation nudge use — one answer to "which of you is this", rather than a
 * third hash that would drift out of step with the other two. It also spreads
 * the PERIOD and not only the offset, or a shop that started blinking together
 * would stay together forever.
 *
 * Four stages rather than a curve because of the signature above: a blink is
 * 140ms and a smooth one would defeat the compare that keeps every other body
 * in the shop free. It reads as a snap, which is what a blink is.
 */
function blinkAt(t, phase) {
  const period = BLINK_EVERY + (phase / (Math.PI * 2)) * BLINK_SPREAD;
  const at = (t + phase * 3) % period;
  if (at > BLINK_TIME) return 0;
  return 3 - Math.abs(Math.round((at / BLINK_TIME) * 6) - 3);
}

/**
 * Recompose one part's local matrix from its own authoring plus an offset.
 *
 * From `desc.parts` rather than from the matrix that is there, and that is the
 * one thing in this file that would fail silently: read back and adjusted, every
 * frame would compound on the last one and a shopper's eyebrows would walk off
 * the top of their head over about a minute. The authored numbers are the truth
 * and this is a pure function of them.
 */
function write(c, i, { dx = 0, dy = 0, sx = 1, sy = 1, rz = 0 }) {
  const p = c.desc.parts[i];
  P.set(p.position[0] + dx, p.position[1] + dy, p.position[2]);
  S.set(p.scale[0] * sx, p.scale[1] * sy, p.scale[2]);
  E.set(p.rot ? p.rot[0] : 0, p.rot ? p.rot[1] : 0, (p.rot ? p.rot[2] : 0) + rz);
  Q.setFromEuler(E);
  c.locals[i].copy(M.compose(P, Q, S));
}
