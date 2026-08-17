#!/usr/bin/env node
/**
 * VERIFY: A MACHINE THAT IS RUNNING LOOKS LIKE IT.
 *
 * An appliance mid-batch and one nobody has loaded since Tuesday drew the same
 * picture until `work` and `motion` existed. Everything this sweep guards about
 * them is invisible — not "invisible in a screenshot of one seed", but
 * invisible in a screenshot *full stop*, because a still frame of a machine
 * cannot show you whether the thing was moving.
 *
 * Five claims, each of which fails as something other than itself:
 *
 * - **A part flagged `motion` becomes a moving part, and the right one.**
 *   `buildModel` drops `seam` parts on the way past, so the meshes are not the
 *   parts — matching them up by index afterwards spins the box next to the one
 *   you flagged, which reads as bad art rather than as bad wiring. So the
 *   collection has to happen where the meshes are made, and this asserts it
 *   survives a dropped seam.
 * - **A spin accumulates.** Read off the clock and eased to zero, a stopping
 *   blade drags itself back to where it was drawn — a machine that rewinds as it
 *   slows. Nobody would think to look for that, and it is one line either way.
 * - **An idle machine sits exactly where it was drawn.** Not approximately: a
 *   pose that settles a hair off is a fixture that quietly moved house, and it
 *   would take a diff of two screenshots to ever notice.
 * - **`work` is staged by the BATCH, not by the tier.** They are two 0..1s and
 *   one resolver, and the whole reason `work` is a second model is that the
 *   first one's is already spent. A `work` that answered to the tier would look
 *   perfect on a tier-1 machine and freeze on stage 1 forever after.
 * - **A variant's own working look beats the piece's, and the piece's is the
 *   fallback.** Every appliance is a variant of one `station` row, so a
 *   fallback that pointed the wrong way is six machines steaming out of the
 *   same corner — which reads as bad authoring on five of them.
 *
 * Unlike `verify:catalog` this writes NOTHING: every piece it needs is built
 * here and every function it calls is pure, so it can be run against the live
 * database with no cleanup and nothing to leak.
 *
 *   node scripts/verify-motion.js
 */

import { FixtureSchema } from '../shared/schemas.js';
import { partsAt, variantWork, variantModel, tierProgress, stageIndexAt } from '../shared/model.js';
import { buildModel } from '../client/render/props.js';
import { buildLoopingProp, animateMotion, animatePuffs } from '../client/render/motion.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const box = (color, extra = {}) => ({
  shape: 'box', color, pos: [0, 0.5, 0], scale: [0.3, 0.1, 0.1], ...extra,
});

/**
 * A machine authored for this sweep, and deliberately not the shipped one.
 *
 * The same argument `verify:catalog` makes about giving its test shelf a
 * shorter ladder: asserting against the content that happens to be in the game
 * is asserting that nobody has edited it, and content is edited live, by two
 * people, every evening.
 */
const PIECE = {
  id: 'verify-machine',
  kind: 'station',
  name: 'Test Machine',
  model: {
    stages: [
      { name: 'Domestic', at: 0, parts: [box('#111111')] },
      { name: 'Commercial', at: 1, parts: [box('#222222'), box('#333333')] },
    ],
  },
  work: { parts: [box('#f0f0f0')] },
  variants: [
    {
      id: 'own',
      name: 'Has its own',
      model: { parts: [box('#aaaaaa'), box('#bbbbbb', { motion: { kind: 'shake', hz: 8, amount: 0.02 } })] },
      work: {
        stages: [
          { name: 'Early', at: 0, parts: [box('#c0ffee')] },
          { name: 'Late', at: 0.6, parts: [box('#c0ffee'), box('#facade')] },
        ],
      },
    },
    {
      id: 'borrows',
      name: 'Borrows the piece one',
      model: { parts: [box('#dddddd')] },
    },
  ],
  tiers: [
    { name: 'Domestic', cost: 0 },
    { name: 'Commercial', cost: 100, speed_mult: 2 },
  ],
};

// ---------------------------------------------------------------------------
// 1. The gate takes it, and takes it as authored.
//
// A field the schema silently drops is a field that works right up until it is
// read back out of the database, which is a different session and a different
// person.
// ---------------------------------------------------------------------------
const parsed = FixtureSchema.safeParse(PIECE);
check(parsed.success, 'the schema accepts a piece with a working look',
  parsed.success ? '' : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));

const piece = parsed.success ? parsed.data : PIECE;
check(!!piece.work, '`work` survives validation on the piece');
check(!!piece.variants.find((v) => v.id === 'own').work, '...and on a variant that has one');
eq(piece.variants.find((v) => v.id === 'borrows').work, null, '...and is null on one that does not');
eq(piece.variants[0].model.parts[1].motion.kind, 'shake', '`motion` survives on a part');
eq(piece.variants[0].model.parts[0].motion, null, '...and a part without one says so rather than going missing');

{
  const bad = FixtureSchema.safeParse({
    ...PIECE, variants: [{ ...PIECE.variants[0], model: { parts: [box('#aaaaaa', { motion: { kind: 'wobble' } })] } }],
  });
  check(!bad.success, 'a motion nobody implemented is refused at the gate');
}

// ---------------------------------------------------------------------------
// 2. Which working look a machine gets.
// ---------------------------------------------------------------------------
eq(variantWork(piece, 'own').stages.length, 2, 'a variant with its own work uses it');
eq(variantWork(piece, 'borrows'), piece.work, 'and one without falls back to the piece');
eq(variantWork(piece, ''), piece.work, 'as does the standard shape');
eq(variantWork(piece, 'nobody-authored-this'), piece.work,
  'and so does a shape that no longer exists, rather than nothing');
eq(variantWork({ ...piece, work: null }, 'borrows'), null,
  'a piece with no working look anywhere answers null, which is every fixture that predates this');

// ---------------------------------------------------------------------------
// 3. `work` answers to the batch, `model` answers to the tier.
//
// The whole reason there are two models. If this ever collapses into one, a
// machine's working look freezes at whatever stage its tier lands on.
// ---------------------------------------------------------------------------
{
  const work = variantWork(piece, 'own');
  // The STANDARD shape, because that is the one whose model is staged by tier —
  // which is the half of this claim that needs a ladder to be about anything.
  const model = variantModel(piece, '');

  eq(stageIndexAt(work, 0), 0, 'a batch that has just started draws its first stage');
  eq(stageIndexAt(work, 0.99), 1, 'and one about to finish draws its last');
  eq(partsAt(work, 0).length, 1, 'which is a different picture');
  eq(partsAt(work, 1).length, 2, '...from the other end of the batch');

  const tier1 = tierProgress(1, piece.tiers.length);
  const tier2 = tierProgress(2, piece.tiers.length);
  eq(partsAt(model, tier1).length, 1, 'the machine itself is what its tier says');
  eq(partsAt(model, tier2).length, 2, '...and steps up when the tier does');

  // The two numbers are not interchangeable, which is the whole reason `work`
  // is a second model rather than more parts on the first. Fed the tier, this
  // machine's working look would sit on stage 1 for the entire life of a
  // Commercial one — a batch that is always finished, and never seen starting.
  check(stageIndexAt(work, tier2) !== stageIndexAt(work, 0.1),
    'a tier and a batch pick different stages, so nothing may pass one where the other is meant');
}

// ---------------------------------------------------------------------------
// 4. A flagged part becomes a moving part — and survives a dropped seam.
//
// The trap this exists for: `buildModel` skips `seam` parts against a
// neighbour, so a moving part collected by index afterwards is the wrong mesh.
// ---------------------------------------------------------------------------
{
  const model = {
    parts: [
      box('#e00000', { seam: true, pos: [0, 0.5, 0.45] }),
      box('#00e000'),
      box('#0000e0', { motion: { kind: 'spin', hz: 4 } }),
    ],
  };
  const open = buildModel(model, {});
  eq(open.userData.moving.length, 1, 'one flagged part, one moving part');
  eq(open.userData.moving[0].mesh.material.color.getHexString(), '0000e0',
    'and it is the part that was flagged');

  const closed = buildModel(model, { abuts: () => true });
  eq(closed.children.length, 2, 'a seam against a neighbour is dropped, as it always was');
  eq(closed.userData.moving.length, 1, 'and the moving part is still one');
  eq(closed.userData.moving[0].mesh.material.color.getHexString(), '0000e0',
    'and is still the part that was flagged, not the one that took its index');

  eq(buildModel({ parts: [box('#123456')] }, {}).userData.moving.length, 0,
    'a model with nothing flagged has no moving parts and says so with a list');
}

// ---------------------------------------------------------------------------
// 5. What running and stopping actually do.
// ---------------------------------------------------------------------------
{
  const g = buildLoopingProp([
    box('#0000e0', { motion: { kind: 'spin', hz: 4 } }),
    { shape: 'sphere', color: '#eef4f6', pos: [0, 1, 0], scale: [0.2, 0.2, 0.2], alpha: 0.5, drift: true },
  ]);
  eq(g.userData.moving.length, 1, 'a looping prop collects its moving parts');
  eq(g.userData.puffs.length, 1, 'and its drifting ones separately');
  eq(g.userData.held.children.length, 1, 'the solid half is everything that is not drifting');

  const m = g.userData.moving[0];
  const drawn = m.mesh.rotation.y;

  // Idle. Not "close to" where it was drawn — exactly, or a machine nobody has
  // touched has quietly moved.
  for (let i = 0; i < 120; i++) animateMotion(g.userData.moving, i / 60, false);
  eq(m.mesh.rotation.y, drawn, 'an idle machine sits exactly where it was drawn');

  for (let i = 120; i < 180; i++) animateMotion(g.userData.moving, i / 60, true);
  check(m.mesh.rotation.y > drawn + 1, 'a second of running turns it', `${m.mesh.rotation.y.toFixed(2)} rad`);

  // Winding down. The claim is the direction: a blade that slows must not walk
  // backwards toward the pose it was authored in.
  let last = m.mesh.rotation.y;
  let backwards = 0;
  for (let i = 180; i < 600; i++) {
    animateMotion(g.userData.moving, i / 60, false);
    if (m.mesh.rotation.y < last - 1e-9) backwards++;
    last = m.mesh.rotation.y;
  }
  eq(backwards, 0, 'and stopping never turns it back the way it came');

  const stopped = m.mesh.rotation.y;
  for (let i = 600; i < 900; i++) animateMotion(g.userData.moving, i / 60, false);
  eq(m.mesh.rotation.y, stopped, 'a stopped blade stays stopped');

  // ...and the three that go back to a pose really do go back to it.
  for (const kind of ['bob', 'shake', 'pulse']) {
    const p = buildLoopingProp([box('#0000e0', { motion: { kind, hz: 5, amount: 0.05 } })]);
    const rec = p.userData.moving[0];
    const rest = { y: rec.mesh.position.y, x: rec.mesh.position.x, s: rec.mesh.scale.x };
    for (let i = 0; i < 90; i++) animateMotion(p.userData.moving, i / 60, true);
    const moved = rec.mesh.position.y !== rest.y || rec.mesh.position.x !== rest.x
      || rec.mesh.scale.x !== rest.s;
    check(moved, `\`${kind}\` moves while it runs`);
    for (let i = 90; i < 600; i++) animateMotion(p.userData.moving, i / 60, false);
    check(rec.mesh.position.y === rest.y && rec.mesh.position.x === rest.x
      && rec.mesh.scale.x === rest.s, `\`${kind}\` settles back to exactly the pose it was drawn in`,
    `${rec.mesh.position.y} / ${rec.mesh.position.x} / ${rec.mesh.scale.x}`);
  }

  // Steam climbs and thins, on a loop — it must never settle anywhere.
  const puff = g.userData.puffs[0];
  animatePuffs(g.userData.puffs, 0);
  const low = puff.obj.position.y;
  animatePuffs(g.userData.puffs, 1.2);
  check(puff.obj.position.y > low, 'a puff rises');
  animatePuffs(g.userData.puffs, 2.4);
  check(Math.abs(puff.obj.position.y - low) < 1e-6, 'and starts again rather than sailing off');
}

// ---------------------------------------------------------------------------

console.log(`\nverify:motion — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  a running machine looks like one, and a stopped one stays where it was drawn.\n');
