/**
 * THINGS THAT KEEP GOING.
 *
 * The one thing an authored model genuinely cannot say is a LOOP. A stage arc
 * plays once — across a break, across a batch, across a season of growth — and
 * a blade has to keep turning and a kettle has to keep steaming for as long as
 * the thing is on. So the arc stays authored and the loop lives here, which is
 * the same split the rest of the renderer makes.
 *
 * Two loops, and both are read off flags on a part rather than off a second
 * kind of model:
 *
 *   `drift`   the part leaves whoever is holding it — rising, spreading and
 *             fading, on a cycle. Steam, vapour, the glow off a phone screen.
 *   `motion`  the part moves in place — spinning, bobbing, juddering, pulsing —
 *             for as long as whatever owns it is *working*.
 *
 * It lives in its own file because it has two callers who share nothing else:
 * a worker on a break (render/pastime.js) and an appliance mid-batch
 * (render/scene.js). Two copies of a puff is two things that drift apart, and
 * the pastime's was here first — this is that code, moved rather than rewritten.
 *
 * Everything here is driven by a clock in SECONDS and eases rather than
 * switching, for the reason every animator in this renderer does: state arrives
 * at 10Hz and the page draws at 60, so anything that only moved when the
 * snapshot did reads as a rendering fault rather than as a machine running.
 */

import * as THREE from 'three';
import { buildModel, material } from './props.js';
import { skinnedParts } from '../../shared/model.js';

/** Seconds for one rise-and-fade of a drifting part. */
const PUFF_SECONDS = 2.4;
/** How far a puff climbs over one cycle, in tiles. */
const PUFF_RISE = 0.5;
/** How opaque a puff is at the bottom of its climb. It thins to nothing from here. */
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

/** How fast a moving part spins up and winds down, per frame. */
const SETTLE = 0.06;
/** Close enough to stopped to stop. */
const STOPPED = 0.008;
/** The biggest step the spin accumulator will take, so a backgrounded tab doesn't lurch. */
const MAX_STEP = 0.1;

const TAU = Math.PI * 2;

/**
 * A prop built from parts, split into the halves that move differently.
 *
 * Split at BUILD time rather than at animate time because the two halves need
 * different transforms: everything solid rides the thing it belongs to as one
 * group, while each drifting part needs a transform of its own to climb on.
 * Which half a part is in is the `drift` flag and nothing else.
 *
 * `held` is always a group, even when there is nothing to draw, so a caller can
 * reach through it without asking first — the alternative is a null check in
 * every animator, and the one animator that forgot it is a crash on an empty
 * model rather than a prop that isn't there.
 *
 * `skin` is the palette of whoever is holding it, and it defaults to null
 * because only one of the two callers has one: a break is worn by a unit with a
 * chassis, a trim and a glow, and an appliance mid-batch is furniture. Passing
 * it means a `tint` on a prop's part reads the same slots the body does, so a
 * charge cable glows the colour of the machine on the end of it rather than
 * being the one part of a repainted bot that is still the colour it shipped in.
 */
export function buildLoopingProp(parts, { castShadow = false, skin = null } = {}) {
  const g = new THREE.Group();
  // Worn ONCE, here, rather than handed down to each `buildModel` below — a
  // drifting part is repainted every frame by `fade()` off the colour recorded
  // in its puff record, so a puff built from a skinned part and remembered from
  // an authored one would flip back to the colour it shipped in on frame two.
  // Skinning the list up front means every reader downstream — the split, the
  // puff's colour, the mesh loop — sees the same worn part.
  //
  // The PALETTE only, never `extras`. A skin is two things: colours for slots,
  // and up to four parts bolted onto the body wearing it. The first is what a
  // prop wants; the second belongs to the body and nothing else, so handing the
  // whole skin over would staple a repainted bot's decals onto the mug in its
  // hand — once per prop, on top of the pair already on the body.
  const list = skinnedParts(parts ?? [], skin ? { slots: skin.slots } : null);

  const held = buildModel({ parts: list.filter((p) => !p.drift) }, { castShadow });
  g.add(held);

  const puffs = [];
  for (const part of list.filter((p) => p.drift)) {
    const base = part.pos ?? [0, 0, 0];
    // Built at the origin and *moved* there, rather than built where it was
    // authored. A puff swells as it climbs, and scaling a group scales its
    // children's offsets too — so a cloud authored out at the spout would sail
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
  // Whatever inside it moves in place. Only the solid half can: a puff is
  // already going somewhere.
  g.userData.moving = held.userData.moving ?? [];
  return g;
}

/** Every drifting part of a prop, one frame. `t` is seconds. */
export function animatePuffs(puffs, t) {
  for (const puff of puffs ?? []) {
    const cycle = (t / PUFF_SECONDS + puff.phase) % 1;
    puff.obj.position.y = puff.base[1] + cycle * PUFF_RISE;
    puff.obj.position.x = puff.base[0] + Math.sin(cycle * 5 + puff.phase * 6) * 0.06;
    // Spreading as it climbs is most of what makes it read as vapour rather
    // than as a ball going up.
    puff.obj.scale.setScalar(0.65 + cycle * 1.1);
    if (puff.mesh) puff.mesh.material = fade(puff.color, 1 - cycle, puff.alpha);
  }
}

/**
 * Every `motion` part of a prop, one frame. `t` is seconds, `running` is
 * whether the thing it belongs to is working right now.
 *
 * `running` is eased rather than switched, so a blender winds down over about
 * half a second instead of stopping dead on the tick a batch finishes — and a
 * machine that has been idle since the shop opened costs one compare and a
 * `continue`, which matters when it is every fixture in the building.
 *
 * A spin ACCUMULATES rather than being read off the clock, and that is not a
 * style choice: `sin(t)` eased to zero would drag the blade back to where it
 * was drawn as it slowed, which reads as a machine rewinding. Adding up how far
 * it has turned means slowing down is slowing down, and it stops wherever it
 * happened to be — which is what a stopped blade does.
 */
export function animateMotion(moving, t, running, signal = null) {
  for (const m of moving ?? []) {
    // A sweep is a POSE, not a loop, so it takes none of what follows: no clock,
    // no phase, and above all no easing. `running` eases a blade up and down
    // because a machine switching on is a thing you should be able to watch; a
    // clock hand that eased in from twelve on the frame the shop loaded would be
    // a clock that is wrong for the first half-second, every time. It is also
    // the one kind that can legitimately have nothing to say — a snapshot that
    // has not arrived — and holding still is the honest answer to that.
    if (m.motion.kind === 'sweep') {
      if (signal != null) pose(m, signal);
      continue;
    }
    const was = m.amp ?? 0;
    const want = running ? 1 : 0;
    const amp = Math.abs(want - was) < STOPPED ? want : was + (want - was) * SETTLE;
    // Idle, and already sat in the pose it was drawn in. The cheap case, and
    // the one nearly every part in the shop is in.
    if (!amp && m.amp === 0) continue;
    const dt = Math.min(MAX_STEP, Math.max(0, t - (m.at ?? t)));
    m.at = t;
    m.amp = amp;

    const { kind, hz = 1.5, amount = 0.05 } = m.motion;
    const beat = Math.sin((t * hz + m.phase) * TAU);
    if (kind === 'spin') {
      m.angle = (m.angle ?? 0) + dt * hz * amp * TAU;
      m.mesh.rotation.y = m.rot + m.angle;
    } else if (kind === 'bob') {
      m.mesh.position.y = m.pos.y + beat * amount * amp;
    } else if (kind === 'shake') {
      m.mesh.position.x = m.pos.x + beat * amount * amp;
      m.mesh.position.z = m.pos.z + Math.cos((t * hz * 1.3 + m.phase) * TAU) * amount * amp;
    } else if (kind === 'pulse') {
      const k = 1 + beat * amount * amp;
      m.mesh.scale.set(m.scale.x * k, m.scale.y * k, m.scale.z * k);
    } else if (kind === 'scroll') {
      // A conveyor slat: travels along the belt's own +x and wraps.
      //
      // It ACCUMULATES for `spin`'s reason, which is sharper here rather than
      // weaker: read off the clock and eased down, a stopping belt slides its
      // slats backwards, and a conveyor that reverses as it halts is a thing
      // you look at for a while before believing.
      //
      // `span` is a distance rather than an angle, so the wrap is a modulo and
      // not a full turn — and it must never be zero, or every slat welds itself
      // to the spot it was drawn on and the belt is a still photograph of a
      // belt.
      const span = amount || 0.25;
      m.travel = ((m.travel ?? 0) + dt * hz * amp * span) % span;
      if (m.arc) {
        // A slat going round a bend. It travels the same distance per second as
        // one on a straight — the wrap is still `span` — but the distance is arc
        // length, so the angle it turns through is that over the radius. Without
        // this a corner cell either holds still while the run either side of it
        // moves, or slides its bars sideways off the curve they are drawn on.
        const a = m.baseA + m.arc.dir * (m.travel / m.arc.r);
        m.mesh.position.set(
          m.arc.cx + Math.cos(a) * m.arc.r, m.pos.y, m.arc.cz + Math.sin(a) * m.arc.r,
        );
        m.mesh.rotation.y = -a;
      } else if (m.dir) {
        // These live at world coordinates in `staticRoot` rather than inside a
        // model that has been turned for them, so the direction has to be said.
        m.mesh.position.set(m.pos.x + m.dir.x * m.travel, m.pos.y, m.pos.z + m.dir.z * m.travel);
      } else {
        m.mesh.position.x = m.pos.x + m.travel;
      }
    }
  }
}

/**
 * One `sweep` part put where the world says it should be. `v` is the signal,
 * 0..1.
 *
 * Turned NEGATIVE, because every angle in three.js is anticlockwise about its
 * axis and every dial anybody has ever read goes the other way. A hand that ran
 * backwards would be the kind of bug you look at for a while before believing.
 *
 * The hinge is done by hand rather than by nesting each hand in a pivot group,
 * which is the usual answer and costs an extra Object3D per part plus a matrix
 * update the welder would have to be taught to leave alone. A rotation about a
 * point is a rotation about the middle plus the arm swung round with it, and
 * that is two lines.
 */
function pose(m, v) {
  const angle = -v * (m.motion.turns ?? 1) * TAU;
  m.mesh.rotation[m.axis] = (m.axis === 'y' ? m.rot : 0) + angle;
  if (!m.arm) return;
  m.mesh.position.copy(m.arm).applyAxisAngle(AXES[m.axis], angle).add(m.pivot);
}

/** The three axes, once, rather than a fresh vector per part per frame. */
const AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/** A shared, quantised, translucent material — see FADE_STEPS. */
function fade(color, k, peak) {
  const step = Math.max(1, Math.round(Math.min(1, Math.max(0, k)) * FADE_STEPS));
  // Rounded, or the cache key is a float like 0.08000000000000002 and every
  // frame mints a material nobody will ever hit again.
  return material(color, Math.round((step / FADE_STEPS) * PUFF_ALPHA * peak * 100) / 100);
}
