# The "Cel + Ink" look — the shadow rig, and what is left

Read `CLAUDE.md` first. The look is **built and working**. §2 was the open
problem and is now closed; §4 is the short list of smaller calls still open.

The original brief is the previous handoff. Do not redesign the look — the
numbers came out of `client/lab/` (`/lab.html`, dev only, never built) and are
settled. `PRESETS.cel.patch` in `client/lab/presets.js` is still the reference,
and the lab is still the tuning tool.

---

## 1. What is already shipped and working

| File | What it is |
|---|---|
| `client/render/look.js` | **New.** Every number, one file, no UI. The switch lives in `sns-view` in localStorage; `__sns.scene.setLook(false)` from the console. |
| `client/render/post.js` | **New.** The ink pass — contour, grade, sRGB. Own render targets, no `EffectComposer`. |
| `client/render/props.js` | `material()`/`characterMaterial()` resolve to `MeshToonMaterial` under the look; `litMaterial`/`batchMaterial` follow by clone. Also `paintLit` clamps the bake — see §3. |
| `client/render/scene.js` | The hook in `render()`, `setLook()`, `fitShadowSpan()`, the day-cycle light, the sky pair. |
| `client/main.js` | `saveView` spreads rather than overwrites, so `look` survives. |
| `client/lab/lab.js` | Pins the base materials to Lambert at boot (`setLookOn(false, false)`) so `stock` is still the control. |
| `scripts/verify-look.js` | **New.** 78 assertions, wired into `npm run verify`. Mutation-tested. |

Verified live in a real shop: 81 static meshes all toon with the look on and all
Lambert with it off; the composite is colour-exact (mean 0.34/255 over 42k flat
pixels with the grade neutral and the ink off).

⚠️ `verify:hand` fails. That is **pre-existing** — from the uncommitted work in
`server/sim/index.js`, not from any of this. Nothing here touches `server/` or
`shared/`, and `verify:look` asserts that.

---

## 2. CLOSED: the shadow acne, and what it turned out to be about

**The symptom.** A regular lattice of small triangles across the whole face of a
shop wall, at normal play zoom. It reads as a *texture* somebody applied, which
is why it cost an afternoon. Proven to be the shadow and nothing else: with
`sun.castShadow = false` the wall was perfectly clean, and neither the ink
(`inkAmount 0`), the creases (`creaseInk 0`) nor the composite changed it.

**The cause was the filter, and the filter was never the thing being bought.**
Cel + Ink wants the hardest shadow in the game — the ramp fills a shaded face
with a flat block, so a shadow that fades into it is the only gradient left in
the picture — and it went after that by switching `PCFShadowMap` to
`BasicShadowMap`. That is the wrong lever twice over:

- **PCF's tap is a texel wide, so how soft a filtered shadow looks is a fact
  about the TEXEL and not about the filter.** The look had already shrunk the
  texel about four times over — the span is fitted to the view
  (`fitShadowSpan`) and the map is doubled (`SHADOW_MAP_LOOK`) — so the same
  tap that blurs six centimetres of wall in the shipped shop blurs one and a
  half here. Hard to the eye at this camera, and still a filter.
- **That same tap is the only thing standing between this scene and its own
  self-shadowing.** Unfiltered, every bit of acne becomes a hard binary
  speckle. And the game has a face the lab does not: the shop's `+z` wall lies
  at **74°** to `SUN_OFFSET` (26, 40, 14), which is the worst case there is, and
  which is why the wall was the thing that showed it and why the bias fix
  measured clean elsewhere.

So `SHADOW_HARD` is gone — the constant, both branches and the `setLook` line —
and the shadow map is `PCFShadowMap` unconditionally. The fitted span and the
2048 map **stay**, and they are now the whole mechanism: hardness is bought by
shrinking the texel, never by dropping the tap. The three are one decision and
the argument is written at `SHADOW_SPAN_MIN` in `client/render/look.js`.

`PRESETS.cel.patch` in `client/lab/presets.js` moved with it (`shadowHard:
false`), so the reference and the game agree. It is the one number in that patch
decided in the shop rather than in the lab, and it says so: the lab's set has no
face standing near-parallel to its own sun, so it could never have shown this.

**`SHADOW_NORMAL_BIAS_TEXELS = 2.5` is kept and is still correct**, but it is
*not* what fixes the lattice, and the file now says so. Offsetting along the
normal buys clearance of `bias / cos(angle to the sun)`, so a couple of texels
covers any angle on paper. Raising it further peter-pans the shadows off their
objects; it was never going to be the answer. What is worth keeping is the
derivation — the bias must scale with the shadow texel, and the first version was
a constant lifted from the lab (whose map is 4096, so it was short by ~5×).

**`verify:look` §6 grew two assertions** and is 78 now. The new pair is the
claim the rig rests on: `SHADOW_MAP_LOOK >= 1024`, and the widest the fitted
texel can ever be is at most half the shipped one. Both halves, or the claim is
satisfied by a fit that covers one tile. Mutation-tested — map back to 1024, map
to 512, and the fit handing the span back were all caught.

**What this cost.** A PCF tap per lit fragment, which is what the game shipped
with. `SHADOW_MAP_LOOK` at 2048 is still the one real frame cost of the look and
is still the first thing to hand back on a machine that is struggling; what that
costs now is softness rather than correctness.

**If a lattice is still there**, it is not the shadow filter and the next thing
to rule out is the geometry: reproduce by driving a browser to a shop wall at
play zoom (the user's shop is `demo-world`, which has **no painted faces**, so
the wall is a bare 0.17-thick box and brick relief is not in the picture).
`page.screenshot()` **lies about this canvas** — read the drawing buffer
instead: `drawImage(canvas, sx, sy, w, h, 0, 0, w, h)` at **1:1** into an
offscreen canvas, then `toDataURL`. Downscaling averages the lattice into flat
grey and tells you it is fixed when it is not. The MCP `screenshot` tool
downscales too, and it lied about the ink being missing for a whole round of
this task.

---

## 3. Three lighting bugs that were found and fixed — do not undo these

The lab lights a set with three fixed lights. The shop has four things it has
never seen, and each of them broke the port in a way that looked like the toon
shading being wrong rather than like a number:

- **The day cycle.** The lab's numbers were applied as a *ratio* on it, which
  punishes the dark end hardest: at dusk the fill is 0.38, and 0.69 of that in
  `FILL_DUSK`'s blue-grey puts the entire shop into the bottom band. Now the
  look moves the **noon end** (`AMBIENT_NOON`, `SUN_NOON`) and leaves dusk
  exactly where the game had it. Same shape `SKY_TOP` uses. Pinned in
  `verify:look` §5b.
- **`spill`.** Every lamp too far for a real light, folded into the ambient. It
  reaches 0.29 in a mature shop, so added raw onto a fill tuned to 0.62 it is a
  57% overshoot — the fill ends up level with the sun and the ramp has nothing
  to band. Now capped at the noon fill. Pinned in §5c.
- **The bake.** `paintLit` writes a per-vertex brightness that runs to 2.07
  where lamps overlap, and a quarter of all vertex colours in a real shop are
  above 1. Under a toon ramp the shaded term is already at the top step, so
  anything above 1 clips the channel to white — a milky haze over the shelves
  that reads as fog. Now clamped to 1 under the look only. Pinned in §5c.
- **8-bit linear.** The scene target was `UnsignedByteType` storing *linear*
  light, which collapses the darks — colours that read as "off" and ink lines
  that read as grey. It is `HalfFloatType` now, like the lab.

---

## 4. Smaller calls still open

- **DONE — the ink read grey because AN INK IS COVERAGE, NOT LIGHT.** It mixed
  toward `#171219` **in linear light**, so `INK.AMOUNT` described a fraction of
  the *energy*: half way to black leaves a surface at about 70% of its
  brightness, which is a grey smear rather than a stroke — and no value of the
  dial reads as ink, because the dial was answering a different question. `lay`
  in `post.js` does the mix after the transfer instead (round-tripped, so the
  rest of the file stays linear for the grain and the vignette the lab has), and
  0.53 is now 53% coverage. Changed in **both** `post.js` and
  `client/lab/pipeline.js`: the lab is the reference, so a look tuned against a
  lab doing different arithmetic is a look tuned against nothing.
- **Compare the lab at the GAME's zoom.** `silWidth` is in screen texels, so a
  3-texel contour sits on an object three times bigger at the lab's `zoom: 4`
  than at play zoom, and reads as a fine line there and a fat one here. Half of
  "it doesn't look the same" is that. The two other measured gaps are smaller
  than they look: the game draws at `dpr 1.70` against the lab's 2.0
  (`PIXEL_BUDGET`, 15%), and `INK_NORMAL_SCALE` halves the normals buffer —
  which costs nothing today, since the creases are off (see below).
- **The sun is higher than the lab's.** The game's sits at ~54°
  (`SUN_OFFSET`); the lab draws at 40°. Higher sun means less difference
  between faces, so the bands are flatter. Note 40° is the lab's *stock*
  default and not part of the cel patch, which is why it was left alone — but
  it is a real part of "it doesn't look the same". Also relevant to §2: a lower
  sun makes wall acne worse, not better.
- **Markers are inked deliberately.** Looked at in build mode with a shelf
  hovered; the amber cage stays crisp and the contour helps it sit in the
  scene. No layer-skip was built. Revisit if anything new looks muddied.
- **`INK_NORMAL_SCALE = 0.5`** — the normals buffer is half size. Note that
  `CREASE_WIDTH: 0.2` is a *sub-texel* offset, so with nearest sampling the
  crease detector contributes **nothing** at the shipped settings (measured:
  identical frames with `creaseInk` 0 and 0.39). That is true in the lab too.
  It is not a bug, but do not spend time tuning creases believing they are on.

---

## 5. Verify

`npm run verify` — everything passes except the pre-existing `verify:hand`.
`node scripts/verify-look.js` on its own is 78 assertions and about a second.

If you change the shadow rig, `verify:look` §6 is the section that will move.
Mutation-test whatever you write there before believing it — four of the five
deliberate breaks tried against it were caught, and the fifth turned out to be
three's `DataTexture` already defaulting `unpackAlignment` to 1.

No content was touched, so no `npm run export` is needed.
