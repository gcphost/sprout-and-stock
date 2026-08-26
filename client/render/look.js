/**
 * CEL + INK — every number the look is made of, in one file.
 *
 * There is no settings panel and there is not going to be one. What there is
 * instead is this: the whole art direction as named constants with the argument
 * for each written next to it, so tuning is editing one file rather than
 * hunting through a shader. `post.js` reads the ink and the grade, `props.js`
 * reads the shading, `scene.js` reads the light, the sky and the shadow rig.
 *
 * WHERE THE NUMBERS CAME FROM. `client/lab/` is a dev-only style lab
 * (`/lab.html`, never built) that draws the real art through a pipeline of its
 * own, and `PRESETS.cel.patch` in `client/lab/presets.js` is where these were
 * arrived at by eye against real shop art. That is still the tuning tool: when
 * the look needs adjusting it gets adjusted THERE first, against a set that is
 * one key away from the control, and the numbers get copied across. Changing a
 * number here against an argument rather than against a screenshot is how a
 * hand-tuned look stops being one.
 *
 * The one thing the lab cannot say is anything that moves. Every value below
 * that the lab holds STILL — the sun's brightness, the sky, the shadow span —
 * is expressed here as a multiplier or a noon value rather than as the literal,
 * because the game has a day cycle and the lab has a slider. Write the literal
 * in and dusk stops happening, which is a whole feature traded for a frame that
 * matches a screenshot.
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ shading */

/**
 * How many steps the light is banded into, and how dark the bottom one is.
 *
 * `SHADOW_FLOOR` is the difference between a shaded object and a SHADOW BLOCK.
 * A ramp running to zero gives a shadow that is the object's own colour turned
 * down — brown shelving in dark brown — which is shading. A drawn panel does
 * not shade, it fills: the dark step wants to be a long way up from black
 * whatever colour the thing is, or a shelf in shadow is a hole in the shop.
 */
export const BANDS = 3;
export const SHADOW_FLOOR = 0.22;

/* -------------------------------------------------------------------- light */

/**
 * The lab's cel light, as the top of the DAY rather than as a multiplier.
 *
 * The lab lights a set with three fixed numbers and a slider; the shop runs a
 * day cycle that drives all three between open and midday and swings their hue
 * with them (see `syncState` in scene.js — the total light moves 2.5 -> 1.0
 * across an afternoon). So the lab's numbers are only ever a statement about
 * ONE moment of the shop's day, and the only honest question is which.
 *
 * Midday, and the alternative is the bug this replaced. Applied as a ratio the
 * look scales the whole curve, which punishes the dark end hardest: the fill at
 * dusk is 0.38 and 0.69 of that is 0.26, in the blue-grey of `FILL_DUSK` — and
 * under three bands with a floor of 0.22 that puts the entire shop into the
 * dark step. What it reads as is a brown, muddy evening that looks nothing like
 * the lab, on a look that matches the lab exactly at noon, which is not a
 * complaint anybody can locate.
 *
 * So these are NOON, `daylight` still ramps from the same dusk the game always
 * had, and the shape is deliberately the one `SKY_TOP` already uses: a look
 * tunes the top of the day and leaves the sunset alone.
 *
 * The numbers are `PRESETS.cel.patch` in `client/lab/presets.js` verbatim; what
 * they sit against are the game's own noon values, restated in the comments so
 * the direction each one moved is readable here rather than only in a diff.
 */
export const AMBIENT_NOON = 0.62;   // against the shipped 0.90 — a lower fill,
export const SUN_NOON = 1.45;       // ...and a harder sun (1.30), which is what
export const BOUNCE_LOOK = 0.24;    // gives a banded ramp anything to band.

/**
 * ...and the two ends the game already had, restated for the same reason.
 *
 * `syncState` writes `0.30 + daylight * 1.00` and `0.38 + daylight * 0.52`, and
 * what the look replaces is only the SECOND term. Naming the dusk end here
 * rather than leaving the arithmetic inline keeps the pair together: change one
 * end without the other and the look stops meeting the shipped curve at dawn,
 * which is a seam nobody would look for at six in the morning.
 */
export const SUN_DUSK_LEVEL = 0.30;
export const AMBIENT_DUSK_LEVEL = 0.38;

/**
 * The sky at NOON, which is the only moment the lab was ever looking at.
 *
 * The shop lerps its sky from dusk to these across the morning, so handing it a
 * pair rather than a colour keeps the sunset and lands the midday frame on the
 * tuned one. A touch deeper at the top and a touch less bright at the horizon
 * than the shipped sky — a banded shop wants a sky with a little more in it, or
 * every silhouette is drawn against the same flat white.
 */
export const SKY_TOP = '#bfe4f2';
export const SKY_HORIZON = '#eaf6fb';

/* --------------------------------------------------------------------- ink -- */

/**
 * THE CONTOUR, in six numbers, and they are one decision rather than six.
 *
 * What they say together: catch almost EVERY edge (`SIL_THRESH` very low), draw
 * the outer line fine and the interior seams finer still (1.4 against 0.2), make
 * them perfectly hard (`SHARP` 0), and then pull the whole lot back to half
 * strength. The result is a drawn line over the ENTIRE shop rather than a heavy
 * outline round the near things — which is also why `FADE` is low: the far half
 * of the aisle is meant to keep its lines. It is not an outline filter, and
 * every attempt to make it read as one by raising `AMOUNT` and `SIL_THRESH`
 * together has come back looking like a render with a border on it.
 *
 * WIDTH IS IN SCREEN TEXELS, WHICH IS WHY THE ZOOM YOU TUNE AT IS PART OF THE
 * NUMBER. `SIL_WIDTH` is a sample offset, so the band it lights is about twice
 * it whatever is being drawn — a pen line, constant weight, which is right. What
 * that means is that the same number reads as a fine line on an object filling
 * the frame and as a fat one on a shelf at play zoom, and the lab's `zoom: 4` is
 * three times closer than the shop is ever played at. 3.0 came from there and
 * was too thick everywhere it was actually used; 1.4 is the same decision made
 * at the zoom the game runs at. Retune at play zoom, not at the zoom that
 * flatters it.
 *
 * TWO WEIGHTS is the part a single-width outline can never have. `SIL` is where
 * one object ends and another begins, found in DEPTH, and wants to be thick.
 * `CREASE` is where two faces of one object meet — a body seam, the lip of a
 * shelf — which depth cannot see at all, and wants to be thin and lighter.
 * `CREASE_WIDTH` at 0.2 is nearly off and stays exposed anyway: it is what
 * draws the shelf-edge detail that makes a stocked board readable at this
 * camera, and it is the first knob to reach for if the shop goes mushy.
 */
export const INK = {
  /** How much of the contour to draw at all — as COVERAGE, which is what `lay`
   *  in post.js is for. 0 is off, and off costs a pass. */
  AMOUNT: 0.53,
  SIL_WIDTH: 1.4,
  SIL_THRESH: 0.07,
  CREASE_WIDTH: 0.2,
  CREASE_THRESH: 0.49,
  /** How dark an interior line is against the outer one. */
  CREASE_INK: 0.39,
  /** How soft the EDGE of a line is — not how thick. A wide soft line is a grey
   *  smear; a wide hard one is a brush stroke. Thickness is the sample offset. */
  SHARP: 0,
  /** How much thinner a line gets as it goes away. See `inkRef` in post.js:
   *  the reference is the camera's own distance to what it is looking at, and a
   *  constant there is what put every line in the lab on the minimum clamp. */
  FADE: 0.29,
  COLOR: '#171219',
};

/* -------------------------------------------------------------------- grade */

export const GRADE = {
  EXPOSURE: 1.0,
  /** Up, never down. Colour is how a board of apples is told from a board of
   *  carrots across the shop, so every look that muted or re-palettised the
   *  place was rejected — for a playability reason rather than a taste one. */
  SATURATION: 1.22,
  CONTRAST: 1.08,
};

/* ------------------------------------------------------------------- buffers */

/**
 * How big the normals buffer is against the frame, as a fraction.
 *
 * The ink needs screen-space normals, and there is only one way to get them:
 * draw the whole shop a SECOND time through `MeshNormalMaterial`. That is the
 * real cost of this feature, and halving each axis is three quarters of it back
 * for a loss nobody can see — the silhouette is found in depth at full
 * resolution, and the crease is hair-fine by construction.
 *
 * The crease offset is measured in this buffer's OWN texels (`nTexel` in
 * post.js), not the frame's, so `CREASE_WIDTH` keeps its meaning when this
 * changes. Set it to 1 to get the lab exactly.
 */
export const INK_NORMAL_SCALE = 0.5;

/**
 * Multisampling on the scene target.
 *
 * The canvas is asked for `antialias: true` and gets none of it the moment the
 * shop is drawn into a render target instead — so without this, turning the
 * look on would jag every edge in the game and it would read as the ink being
 * rough rather than as MSAA having quietly gone away. WebGL2 resolves the depth
 * buffer along with the colour, which is what makes it usable at all here: the
 * silhouette pass reads that depth.
 */
export const SCENE_SAMPLES = 4;

/* ------------------------------------------------------------------- shadow */

/**
 * A CEL SHADOW IS A SMALL TEXEL, NEVER AN ABSENT FILTER.
 *
 * The look wants a hard edge — the ramp fills a shaded face with a flat block,
 * and a shadow that fades into it is the only gradient left in the picture — and
 * the obvious way to get one is to stop filtering the map (`BasicShadowMap`).
 * That shipped, and it is the wrong lever. PCF taps a small pattern a texel
 * wide, so how soft a filtered shadow looks is a fact about the TEXEL and not
 * about the filter; and the same tap is the only thing standing between this
 * scene and its own self-shadowing. Turned off, every bit of acne in the shop
 * becomes a hard binary speckle — a regular lattice over the whole face of a
 * wall, which reads as a texture somebody applied rather than as a filter
 * somebody removed, and which no amount of `SHADOW_NORMAL_BIAS_TEXELS` reliably
 * clears on a face lying near-parallel to the sun.
 *
 * So the edge is hardened by making the texel small instead, which is what the
 * two numbers below already do: the span is fitted to WHAT IS ON SCREEN each
 * frame rather than to the shipped ±30, and the map is doubled. Between them
 * the texel is about a quarter of the game's own, so a PCF tap that blurs six
 * centimetres in the shipped shop blurs one and a half here — hard to the eye at
 * this camera, and still a filter. The three of them are one decision and may
 * not be shipped apart: give the span back and PCF is soft again.
 *
 * The span is quantised to whole units (`SHADOW_SPAN_STEP`) because the snap
 * grid in `snapToShadowTexel` is derived from it — a span that slid continuously
 * with the zoom would move the grid under the snap every frame, which is
 * precisely the shimmer the snap exists to remove.
 */
export const SHADOW_SPAN_MIN = 10;
export const SHADOW_SPAN_STEP = 2;
/** Tiles of slack past the visible ground, so a shelf just off screen still
 *  casts into it — a shadow that ends at the edge of the frame is a wall of
 *  light sliding across the floor as you pan. */
export const SHADOW_MARGIN = 3;

/**
 * A bigger map, which is the second half of the sentence above.
 *
 * PCF blurs about a texel, so the only way to buy a harder edge without giving
 * up the filter is to spend more texels on the same ground. The fitted span
 * covers a third of the area at the default zoom and this covers it four times
 * over, and together they are what makes a filtered shadow read as drawn.
 *
 * It is also the one place the look genuinely costs frame time — a depth-only
 * pass at four times the fill, on the cadence `SHADOW_EVERY` sets. Turn it back
 * to 1024 first if a machine is struggling; `SHADOW_NORMAL_BIAS_TEXELS` follows
 * it on its own, and what it costs is softness rather than correctness.
 */
export const SHADOW_MAP_LOOK = 2048;

/**
 * How far a surface is pushed along its own normal before the map is sampled,
 * IN TEXELS — and the fact that it is in texels is the whole entry.
 *
 * A shadow map texel covers a patch of world, and across that patch a sloped
 * surface's depth changes; if the change is bigger than the bias, half the
 * patch shadows itself. What that draws is a regular lattice of little
 * triangles over any large lit surface — the wall of a shop, most visibly —
 * and it reads as a TEXTURE somebody put there rather than as a number, which
 * is what makes it cost an afternoon.
 *
 * So the bias has to scale with the texel, and the texel is `span * 2 / map`:
 * both halves of that move under this look, the span every time the zoom does.
 * A constant is the bug this replaced. It was 0.018 — the lab's number, and the
 * lab draws a 4096 map over a small set, so its texel is about a fifth of ours
 * and the constant was short by exactly that factor.
 *
 * 2.5 is the lab's own ratio (0.018 against a texel near 0.007), which is the
 * one number here that was arrived at by eye rather than derived.
 *
 * What it is NOT is the answer to the lattice above. Offsetting along the normal
 * buys clearance of `bias / cos(angle to the sun)`, so a couple of texels covers
 * any angle on paper — and the lab, which is where the ratio came from, has no
 * face standing near-parallel to its own sun to test that against. The shop's
 * `+z` wall does, at 74°, and the filter is what was covering it. Raise this and
 * the shadows come off their objects; the fix was the tap.
 *
 * `bias` stays beside it and stays tiny: it is measured in the map's depth
 * units rather than in world units, so it cannot be made to mean the same thing
 * at two different spans, and leaning on it is what peter-pans a shelf off its
 * own shadow.
 */
export const SHADOW_BIAS = -0.0002;
export const SHADOW_NORMAL_BIAS_TEXELS = 2.5;

/* --------------------------------------------------------------- the switch */

/**
 * Whether the look is on, which is a fact about the PERSON and not the shop.
 *
 * Same category as where the camera is pointing and whether you were building —
 * so it lives in `sns-view` in localStorage beside those, and never on the
 * save, in the schema, on the wire or on the server. Get that right and this
 * whole feature touches no sweep, no balance number and no migration.
 *
 * There is deliberately no UI. The switch exists for a machine that cannot
 * afford a second scene draw, and it is reachable the way every other renderer
 * dial in this game is: `__sns.scene.setLook(false)` from the console.
 *
 * ON is the default, including for anything with no localStorage at all — a
 * verify sweep, a private window, a headless build. OFF has to be
 * byte-identical to the game as it shipped and cost nothing, which is what
 * every `lookOn()` test in the renderer is for.
 */
const VIEW_KEY = 'sns-view';

function stored() {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null');
    return raw?.look !== 'off';
  } catch {
    return true;
  }
}

let on = typeof localStorage === 'undefined' ? true : stored();

export const lookOn = () => on;

/**
 * ...and the mode as a cache key.
 *
 * `material()` in props.js is a cache keyed by colour, and the mode decides
 * what CLASS of material a colour resolves to — so without this in the key,
 * turning the look on hands every existing colour back its Lambert and the
 * rebuild comes out as exactly what it was.
 *
 * The MODE and never a counter, which is the difference between a cache and a
 * leak: keyed by a bump-per-change, flipping the switch twice mints a second
 * full set of materials for a shop that is byte-identical to the one two
 * presses ago, and the GPU programs behind them are never handed back. Keyed by
 * the mode there are two sets, ever, and a round trip is genuinely a round trip.
 * Keyed rather than CLEARED for the other half of the same reason: a mesh still
 * holding the old material goes on drawing correctly until whatever owns it is
 * rebuilt.
 */
export const lookKey = () => (on ? 'cel' : 'off');

/**
 * Returns whether anything changed, so a caller can skip a rebuild.
 *
 * `remember` is for the style lab and nothing else. `client/lab/` draws the
 * game's real art through `props.js`, so the moment `material()` learned about
 * the look the lab's `stock` preset stopped being the control it says it is —
 * it would inherit whatever the GAME was last set to, and its own comparison
 * between stock and toon would be a comparison against itself. It pins the base
 * to the shipped Lambert at boot, and pinning must not reach back and change
 * what the player set: the lab's own first rule is that nothing in it mutates
 * what it imports, and a tuning page that quietly switched somebody's game off
 * is that rule broken in the one direction that costs something.
 */
export function setLookOn(want, remember = true) {
  const next = want !== false;
  if (next === on) return false;
  on = next;
  if (!remember) return true;
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null') ?? {};
    raw.look = on ? 'cel' : 'off';
    localStorage.setItem(VIEW_KEY, JSON.stringify(raw));
  } catch { /* private mode, quota, no storage at all — the flag still moved */ }
  return true;
}

/* ------------------------------------------------------------------- ramps -- */

const ramps = new Map();

/**
 * A toon ramp: N hard steps, sampled with no filtering so they stay hard.
 *
 * Cached, because every material in the shop shares one and rebuilding it per
 * material would be two hundred one-pixel-tall textures.
 */
export function gradientMap(bands = BANDS, floor = SHADOW_FLOOR) {
  const n = Math.max(2, Math.round(bands));
  const key = `${n}@${floor.toFixed(3)}`;
  let t = ramps.get(key);
  if (t) return t;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    data[i] = Math.round((floor + (1 - floor) * (i / (n - 1))) * 255);
  }
  t = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  // One byte per texel, against a Texture default of four. `DataTexture` sets
  // this to 1 itself today, so the line is belt-and-braces rather than the fix
  // it was in the lab — kept, and asserted in `verify:look`, because what the
  // GPU is handed matters and the symptom does not point here: a ramp whose
  // band count is not a multiple of four read off a stride of four comes out
  // with UNEVEN steps, which reads as a badly chosen ramp rather than as a
  // texture upload.
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  ramps.set(key, t);
  return t;
}
