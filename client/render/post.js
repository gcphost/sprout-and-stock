/**
 * THE INK PASS — everything that happens after the shop is drawn.
 *
 * Ported from `client/lab/pipeline.js`, which is where the look was tuned and
 * still is. What came over is the contour, the grade and the sRGB conversion,
 * and nothing else: the lab also carries a palette lock, a paper wash, a
 * duotone, posterise, split-tone, a halftone screen, misregistration, grain, a
 * vignette and bloom, and not one of them is in the shipped look. They are
 * still in the lab, which is where they belong — a knob nobody turns costs a
 * uniform and a branch in the hottest shader in the game.
 *
 * Hand-rolled rather than `EffectComposer`, for one reason that is not taste:
 * the ink pass needs the DEPTH BUFFER of the pass that drew the scene, and a
 * composer ping-pongs between two targets that share one depth attachment — so
 * the pass reading depth is reading the buffer it is also writing behind.
 * Owning the targets means the read and the write are never the same object.
 *
 * Two draws of the shop, in order:
 *
 *   1. COLOUR + DEPTH — the shop, once, multisampled. WebGL2 resolves the depth
 *      along with the colour, which is what makes MSAA usable here at all.
 *   2. NORMALS — the same shop again through `MeshNormalMaterial`, at half size.
 *      This is the second full draw and the real cost of the feature, so it is
 *      skipped outright whenever the ink is off.
 *
 * ...then one fullscreen shader that does both contours, the grade and the
 * conversion together. One pass because every one of those is a per-fragment
 * lookup at the same texel, and chaining them through four targets would be
 * four full-screen bandwidth hits to express arithmetic that fits in one
 * function.
 *
 * ...and then FXAA, which is the ONE thing that could not go in with it, for the
 * reason everything else could: it is the only step here that needs to see the
 * finished picture's NEIGHBOURS rather than its own texel.
 *
 * What it is for is a staircase the rest of the pipeline cannot touch. MSAA
 * smooths the colour edge, and the contour is then painted over that edge out of
 * buffers resolved to one sample — a depth blit is NEAREST, and the normals are
 * half res on `NearestFilter` — so both ink masks are binary per pixel however
 * the thresholds are tuned. See `INK.SHARP` in look.js, which is where the two
 * dead ends are written down: softening the band does nothing to a value that
 * cannot vary, and supersampling the detector does nothing either, because a
 * depth texture is not linearly filterable and a sub-texel offset snaps back to
 * the texel it started in. The steps are in the composed image, so that is where
 * they are dealt with — and a filter that finds a 1px step and blends across it
 * is the one treatment that leaves the line's WEIGHT alone, which a blur of the
 * mask does not.
 *
 * three's own FXAA, deliberately, rather than a hand-rolled one: this file is
 * hand-rolled where the ping-pong would have cost it a depth buffer, and there
 * is no such argument about a stock implementation of a published algorithm.
 * It runs on the sRGB side of the conversion because it works on LUMA, which is
 * a perceptual quantity — fed linear light it would find its edges in the wrong
 * places and mostly ignore the dark ones, which is where the ink is.
 *
 * The whole file is linear-light until the composite's last line, where it
 * converts to sRGB BY HAND. three only does that conversion for its own
 * materials, and a raw `ShaderMaterial` writing to the canvas gets none of it —
 * skip it and every colour in the game is a slightly different shade with
 * nothing to say why.
 *
 * (No backticks anywhere inside the shader strings below. They are template
 * literals, so a stray one ends the string and the error names a GLSL word.)
 */

import * as THREE from 'three';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { INK, GRADE, INK_NORMAL_SCALE, SCENE_SAMPLES } from './look.js';
import { SURROUND_LAYER } from './lights.js';

/** Where a fullscreen pass lives. One quad, one camera, shared. */
const QUAD_GEO = new THREE.PlaneGeometry(2, 2);
const QUAD_CAM = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const COMPOSITE = /* glsl */`
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tScene;
  uniform sampler2D tDepth;
  uniform sampler2D tNormal;
  /* The NORMALS pass's own depth, which is the only thing that can say what was
     not in it. See creaseMask below. */
  uniform sampler2D tNormalDepth;
  /* The frame's texel, for the depth taps, and the NORMAL BUFFER'S own texel
     for the crease taps. Two, because that buffer is half size — measured in
     the frame's texel a crease offset of 0.2 would mean something different the
     day INK_NORMAL_SCALE moved, which is a look that changes when somebody
     tunes a performance dial. */
  uniform vec2 texel, nTexel;

  uniform float near, far, isOrtho;

  uniform float inkAmount, inkSharp, inkFade, inkRef;
  uniform float silWidth, silThresh;
  uniform float creaseWidth, creaseThresh, creaseInk;
  uniform vec3 inkColor;
  uniform float inkLift;

  uniform float exposure, saturation, contrast;

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  /* Distance in front of the eye, in world units, whichever camera drew it. An
     ortho projection is already linear in depth; a perspective one is not, and
     that difference is the whole reason this takes a flag. The shop's ortho
     camera has a NEGATIVE near plane — it sits 200 units behind the eye — which
     this handles without knowing: near + d * (far - near) is the distance to
     the fragment either way, and it simply starts below zero. */
  float linearise(float d) {
    if (isOrtho > 0.5) return d * (far - near) + near;
    return (2.0 * near * far) / (far + near - (d * 2.0 - 1.0) * (far - near));
  }

  float viewDist(vec2 uv) {
    return linearise(texture2D(tDepth, uv).x);
  }

  vec3 readNormal(vec2 uv) {
    return normalize(texture2D(tNormal, uv).xyz * 2.0 - 1.0);
  }

  vec3 toSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(0.4166667)) - 0.055, step(0.0031308, c));
  }

  vec3 fromSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }

  /* AN INK IS COVERAGE, NOT LIGHT, so it is laid down where the picture is
     rather than where the photons are.
     Everything else in this file is linear on purpose — the scene arrives
     linear, the grade is a statement about light — and a line is the one thing
     here that is not. Mixed in linear, inkAmount describes a fraction of the
     ENERGY: half way to black leaves a surface at about 70% of its brightness,
     which is a grey smear rather than a stroke, and no value of the dial reads
     as ink because the dial is answering a different question. Mixed after the
     transfer, 0.53 is 53% coverage and looks like it. The round trip keeps the
     rest of the file linear, which is what grain and a vignette would want. */
  vec3 lay(vec3 base, vec3 ink, float a) {
    return fromSRGB(mix(toSRGB(base), toSRGB(ink), clamp(a, 0.0, 1.0)));
  }

  /* THE OUTER LINE. Depth read as a SECOND derivative, so a floor receding
     under the camera — a large steady gradient over the whole screen — does not
     come out as one enormous line. This is what finds a silhouette, and it is
     the one that wants to be THICK. */
  float silAt(vec2 uv, float w) {
    float dc = viewDist(uv);
    vec2 o = texel * w;
    float dl = viewDist(uv - vec2(o.x, 0.0));
    float dr = viewDist(uv + vec2(o.x, 0.0));
    float du = viewDist(uv - vec2(0.0, o.y));
    float dd = viewDist(uv + vec2(0.0, o.y));
    return (abs(dl + dr - 2.0 * dc) + abs(du + dd - 2.0 * dc)) / max(dc, 0.75);
  }

  /* THE INTERIOR LINE. Where two faces of ONE object meet — a body seam, the
     lip of a shelf, a wheel arch. Depth cannot see these at all, because there
     is no step in depth to find, and they are the ones that want to be THIN.
     Two detectors and two widths is the whole difference between a drawing and
     a render with a border round it. */
  float creaseAt(vec2 uv, float w) {
    vec2 o = nTexel * w;
    vec3 nc = readNormal(uv);
    float ne = 0.0;
    ne = max(ne, 1.0 - dot(nc, readNormal(uv - vec2(o.x, 0.0))));
    ne = max(ne, 1.0 - dot(nc, readNormal(uv + vec2(o.x, 0.0))));
    ne = max(ne, 1.0 - dot(nc, readNormal(uv - vec2(0.0, o.y))));
    ne = max(ne, 1.0 - dot(nc, readNormal(uv + vec2(0.0, o.y))));
    return ne;
  }

  /* ...AND WHERE THERE IS NO INTERIOR TO HAVE A LINE IN, WHICH IS NOT A
     THRESHOLD.
     Two things are deliberately absent from the normals pass — the crowd
     (noCrease, for the draw cost) and the far backdrop (its layer, because the
     haze that dissolves it does not exist under an override material) — and
     absent does not mean blank: what lands in those texels is whatever stood
     BEHIND them. So creaseAt reads the shelf through a shopper and lays the
     shelf's own lip across their face, which is not a wrong line, it is a line
     belonging to a different object. The silhouette is unaffected and that is
     what hid it: outlines come from the colour pass's depth, which has
     everybody in it, so the crowd looked correctly drawn and merely dirty.
     Comparing the two depths is the whole test — the colour pass sees a body in
     front, the normals pass sees the shelf — and it costs one tap.
     THE SLACK IS RELATIVE and it is a floor rather than a tuned value. The
     normals buffer is half res and the scene's depth is resolved from
     SCENE_SAMPLES, so the two disagree by a texel's worth along every
     silhouette however correct both are. Erring large there is free: that band
     is exactly where the SIL line is drawn, so a crease suppressed inside it was
     never going to be seen. Erring small is not — it puts the stray lines back
     on anybody standing close to a wall. */
  float creaseMask(vec2 uv, float dc) {
    float dn = linearise(texture2D(tNormalDepth, uv).x);
    return 1.0 - step(max(0.15, dc * 0.02), dn - dc);
  }

  void main() {
    vec3 col = texture2D(tScene, vUv).rgb * exposure;

    /* ---- the grade ------------------------------------------------------- */
    col = mix(vec3(dot(col, LUMA)), col, saturation);
    col = (col - 0.5) * contrast + 0.5;

    /* ---- the contour, over the top of it ---------------------------------- */
    if (inkAmount > 0.001) {
      float dc = viewDist(vUv);
      /* Lines thin with distance, or the far half of a shop is a black mat.
         Referenced against the CAMERA'S OWN distance to what it is looking at,
         which is the bug this replaced: a hard-coded 20 against a camera parked
         at 70 put every line on the 0.35 clamp for ever, so the fade dial only
         ever said "thin" and the ink drew at about a third of what was
         authored. An ortho projection has no perspective, so the reference
         plane is the only thing "distance" can honestly mean here. */
      float scale = mix(1.0, clamp(inkRef / max(dc, 0.001), 0.35, 1.6), inkFade);
      /* How soft the EDGE of the line is, which is not how thick it is. A wide
         soft line is a grey smear; a wide hard one is a brush stroke.
         Thickness is the sample offset above, and this is only the falloff. */
      float soft = mix(0.015, 0.40, inkSharp);
      float s = smoothstep(silThresh, silThresh + soft, silAt(vUv, silWidth * scale) * 5.0);
      float c = smoothstep(creaseThresh, creaseThresh + soft, creaseAt(vUv, creaseWidth * scale) * 1.35);
      c *= creaseMask(vUv, dc);
      /* A LINE HAS TO BE DIFFERENT FROM WHAT IT IS DRAWN ON, and inkColor is
         near-black — so on anything darker than the ink there is nothing to
         lay. Below inkLift the line is pushed UP off the surface instead: the
         surface's own colour plus that much luminance, so it keeps the hue and
         reads the way a pen does on dark paper. See INK.LIFT in look.js for why
         the dusk skyline is what this is about. The band is narrow on purpose —
         a lit shop is far above it and does not move at all.
         NO BACKTICKS IN HERE: this whole shader is one template literal, so a
         quoted identifier in a comment ends the string. */
      float lum = dot(col, LUMA);
      float dark = 1.0 - smoothstep(inkLift * 0.5, inkLift * 2.0, lum);
      vec3 ink = mix(inkColor, col + vec3(inkLift), dark);
      col = lay(col, ink, max(s, c * creaseInk) * inkAmount);
    }

    gl_FragColor = vec4(toSRGB(col), 1.0);
  }
`;

/**
 * `ShaderMaterial` and deliberately not `RawShaderMaterial`.
 *
 * The raw one injects nothing, so `position` and `uv` arrive as undeclared
 * identifiers and the shader fails to compile with an error that names a
 * variable rather than the material. The plain one prepends the attribute
 * declarations and the precision line, which is all this needs — and it is also
 * what does the GLSL1-to-GLSL3 rewrite on WebGL2, which is why the shader above
 * can be written in the old dialect.
 */
function quad(fragmentShader, uniforms) {
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
  scene.add(new THREE.Mesh(QUAD_GEO, mat));
  return { scene, mat };
}

export class Ink {
  constructor(renderer) {
    this.renderer = renderer;
    this.w = 0;
    this.h = 0;

    /**
     * One flat blue pixel, which decodes to a normal pointing straight at the
     * camera. It stands in whenever the normals pass has not run, so the
     * composite never has to branch on whether the texture exists — an unbound
     * sampler is undefined behaviour, not a black texture.
     */
    this.blank = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    this.blank.needsUpdate = true;

    /**
     * No `fog` on it — the normal material has no such property, and the pass
     * takes the fog off the scene for the duration anyway. Fogged normals would
     * fade every crease in the far half of the shop, which is a contour that
     * thins with distance for a reason nobody chose.
     */
    this.normalMat = new THREE.MeshNormalMaterial({ flatShading: true });

    this.composite = quad(COMPOSITE, {
      tScene: { value: null },
      tDepth: { value: null },
      tNormal: { value: this.blank },
      /* `blank` again, and it is never read through: with no ink the whole
         contour branch is skipped, and this only has to be a bound texture
         rather than a meaningful one. */
      tNormalDepth: { value: this.blank },
      texel: { value: new THREE.Vector2() },
      nTexel: { value: new THREE.Vector2() },
      near: { value: 0.5 },
      far: { value: 200 },
      isOrtho: { value: 1 },
      inkAmount: { value: INK.AMOUNT },
      inkSharp: { value: INK.SHARP },
      inkRef: { value: 37 },
      inkFade: { value: INK.FADE },
      silWidth: { value: INK.SIL_WIDTH },
      silThresh: { value: INK.SIL_THRESH },
      creaseWidth: { value: INK.CREASE_WIDTH },
      creaseThresh: { value: INK.CREASE_THRESH },
      creaseInk: { value: INK.CREASE_INK },
      inkColor: { value: new THREE.Color(INK.COLOR) },
      inkLift: { value: INK.LIFT },
      exposure: { value: GRADE.EXPOSURE },
      saturation: { value: GRADE.SATURATION },
      contrast: { value: GRADE.CONTRAST },
    });

    /* three's fragment shader on this file's own vertex shader, which is the
       one substitution worth naming: the stock one multiplies by
       `projectionMatrix * modelViewMatrix`, and every quad in here is drawn
       through `QUAD_CAM` where that product is the identity. Writing clip space
       straight out is the same picture without the matrix upload.
       `resolution` is FXAA's spelling of a texel — 1/width, 1/height — and not
       a size, which is the one way to wire this shader up wrong and have it
       still draw something. */
    this.fxaa = quad(FXAAShader.fragmentShader, {
      tDiffuse: { value: null },
      resolution: { value: new THREE.Vector2() },
    });
  }

  /**
   * Draw the INTERIOR lines, or leave them to somebody else.
   *
   * The two contours are not additive and there is no version of this where they
   * are: `collectEdges` in props.js finds a crease by asking the geometry where
   * two of its faces meet, and `creaseAt` above finds the same crease by reading
   * the normals buffer at the same pixel. Both on, the drawn line lands
   * underneath the screen-space one, and what comes out is the SAME staircase
   * very slightly darker — which reads as the geometry pass having done nothing.
   * That is not a bug in either of them; they are two answers to one question.
   *
   * So the geometry pass turns this off, and the SILHOUETTE is untouched either
   * way — an edge only exists where an object meets itself, so nothing in the
   * geometry can draw the line between a shelf and the sky behind it. See
   * `buildEdgeLines`.
   */
  setCrease(on) {
    this.composite.mat.uniforms.creaseInk.value = on ? INK.CREASE_INK : 0;
  }

  /** Sized in DEVICE pixels — whatever `renderer.getDrawingBufferSize` says. */
  setSize(w, h) {
    const rw = Math.max(2, Math.round(w));
    const rh = Math.max(2, Math.round(h));
    if (rw === this.w && rh === this.h) return;
    this.w = rw;
    this.h = rh;
    this.dispose(true);

    // A real depth TEXTURE hanging off the colour target, because the contour
    // reads it as an ordinary sampler. A plain depth renderbuffer is faster to
    // resolve and cannot be sampled at all.
    const depth = new THREE.DepthTexture(rw, rh, THREE.UnsignedIntType);
    depth.format = THREE.DepthFormat;
    this.rtScene = new THREE.WebGLRenderTarget(rw, rh, {
      /**
       * HALF-FLOAT, and eight bits is the trap it is here to avoid.
       *
       * Everything in this file is LINEAR light until the last line, and eight
       * bits of linear is not eight bits of picture: sRGB spends most of its
       * code points below mid grey because that is where an eye can tell two
       * shades apart, and linear spends them evenly. Store linear in a byte and
       * the whole bottom half of the range collapses onto a handful of values,
       * so every shaded face, every shadow block and every ink line comes back
       * quantised — colours that read as *off* and lines that read as grey
       * rather than dark, with nothing to point at.
       *
       * It is not what the canvas was getting before this pass existed, which
       * is the reasoning that put a byte here in the first place: three
       * converted to sRGB inside each material and wrote eight bits of sRGB.
       * The conversion moved to the end of the composite, so the buffer in the
       * middle has to be able to hold what it is carrying.
       */
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      depthTexture: depth,
      samples: SCENE_SAMPLES,
    });

    const nw = Math.max(2, Math.round(rw * INK_NORMAL_SCALE));
    const nh = Math.max(2, Math.round(rh * INK_NORMAL_SCALE));
    /* A depth TEXTURE here for the same reason the colour target has one, and
       for one caller: `creaseMask` needs to know what this pass could not see.
       Half res and unsampled by anything else, so it is a couple of megabytes
       and no extra draw — the pass was already writing this depth into a
       renderbuffer it then threw away. */
    const nDepth = new THREE.DepthTexture(nw, nh, THREE.UnsignedIntType);
    nDepth.format = THREE.DepthFormat;
    // Nearest for the same reason the colour attachment below is: a filtered
    // depth is an average of two surfaces, which is a distance nothing is at.
    nDepth.minFilter = THREE.NearestFilter;
    nDepth.magFilter = THREE.NearestFilter;
    this.rtNormal = new THREE.WebGLRenderTarget(nw, nh, {
      type: THREE.UnsignedByteType,
      depthTexture: nDepth,
      // Nearest, deliberately. The crease offset is a fraction of a texel, so
      // what the detector actually measures is whether the tap fell into the
      // NEXT texel — which is what makes a hair-fine line out of a number
      // smaller than a pixel. Filtered, it would lerp toward the centre sample
      // and the interior lines would fade out altogether.
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });

    /**
     * Where the composite lands so that FXAA has something to read.
     *
     * EIGHT BITS, and it is the one target in this file that wants them. The
     * argument for half-float on `rtScene` is that it holds LINEAR light, where
     * a byte spends its code points in the wrong places; this one holds the
     * finished sRGB picture, which is exactly what eight bits of sRGB were
     * defined to carry. Half-float here would be two bytes a pixel for a value
     * that is about to be shown on a display that cannot tell.
     *
     * LINEAR filtering, and that is load-bearing rather than a default: FXAA's
     * whole trick is a tap at a FRACTIONAL offset along the edge it found, and
     * the blend it wants is the hardware's. On `NearestFilter` that tap snaps
     * to a neighbour and the filter degrades to swapping one pixel for another
     * — which is the same staircase one step over, drawn slightly wrong.
     *
     * No depth attachment and no samples. Nothing draws geometry into it.
     */
    this.rtOut = new THREE.WebGLRenderTarget(rw, rh, {
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });

    const u = this.composite.mat.uniforms;
    u.texel.value.set(1 / rw, 1 / rh);
    u.nTexel.value.set(1 / nw, 1 / nh);
    this.fxaa.mat.uniforms.resolution.value.set(1 / rw, 1 / rh);
  }

  /**
   * Draw the shop through the ink.
   *
   * `inkRef` is how far the camera is from what it is LOOKING AT, handed in
   * rather than derived — `camera.position.length()` is a distance from the
   * world origin, which in a shop that is not built at the origin is a number
   * that changes as you walk across your own floor. See the fade above.
   *
   * `noCrease` is whatever gets its OUTLINE but not its interior lines: the
   * crowd, today. See the normals pass below for why that is a saving rather
   * than a compromise.
   */
  render(scene, camera, inkRef, noCrease = null) {
    const r = this.renderer;
    const u = this.composite.mat.uniforms;

    // 1 — the shop, once.
    r.setRenderTarget(this.rtScene);
    r.clear();
    r.render(scene, camera);

    /**
     * 2 — its normals, but only if anybody is going to read them.
     *
     * ...which since `setCrease` is a question with a NEW answer, and it is the
     * cheapest one in the file. The normals buffer has exactly one reader —
     * `creaseAt` — because a silhouette comes out of the colour pass's own
     * depth. So a shop drawing its creases as geometry is a shop where this
     * whole branch is a second full traversal and draw of the scene for a
     * texture nothing samples. Skipping it is not a saving on the ink, it is the
     * ink's entire cost: see the header, where this is named as the real price
     * of the feature, and `INK_NORMAL_SCALE`, which exists only to make it
     * affordable.
     */
    const wantsInk = INK.AMOUNT > 0.001 && u.creaseInk.value > 0.001;
    if (wantsInk) {
      const bg = scene.background;
      const fog = scene.fog;
      const clear = r.getClearColor(SCRATCH);
      const alpha = r.getClearAlpha();
      const shadows = r.shadowMap.enabled;
      scene.background = null;
      scene.fog = null;
      scene.overrideMaterial = this.normalMat;
      /**
       * ...and NOTHING HAS MOVED since the draw above, so the matrices are
       * already right.
       *
       * `render` walks the whole graph and recomputes `matrixWorld` for every
       * object in it unless told otherwise, and this pass is the same scene,
       * from the same camera, microseconds later — so left alone it is a second
       * full traversal of a tree that cannot have changed, once per frame, for
       * an answer identical to the one it threw away.
       *
       * Measured on a day-420 shop at 5pm — 1,640 objects, 34-59 shoppers —
       * `updateMatrixWorld` fell 6.9% -> 3.8% of the tab and `multiplyMatrices`
       * 4.2% -> 2.6%, which is about 4.7% of a saturated main thread for two
       * lines.
       *
       * It is restored below rather than left off, and that is the whole care
       * needed: the flag belongs to the SCENE, not to this pass, so a `render`
       * that threw between here and there would leave every later frame drawing
       * against matrices nobody updates — which is not a crash, it is furniture
       * that stops following the shop it is standing in, and it would arrive
       * looking like a re-flow bug days from here.
       */
      const autoMatrix = scene.matrixWorldAutoUpdate;
      scene.matrixWorldAutoUpdate = false;
      /**
       * ...and THE CROWD IS OUT OF IT, which is the whole cost of this pass in
       * a shop that is busy.
       *
       * A silhouette comes from `tDepth`, which is the colour pass's own depth
       * buffer — so anything dropped here keeps the line round the outside of
       * it and loses only the creases INSIDE it: the seam where an arm meets a
       * torso. At `INK_NORMAL_SCALE` a shopper is a few dozen texels tall and
       * those seams are mostly under one of them already, so what is being
       * given up is a line that was barely resolving. The shop itself — every
       * shelf, wall, machine and crate — is untouched and creases exactly as it
       * did, which is where the drawing actually reads.
       *
       * `visible = false` rather than a layer, and that is the load-bearing
       * half. `projectObject` recurses into an object's children whether or not
       * its LAYER passes, so a layer would skip the draws and still walk all
       * ~1,100 objects a crowd puts in the tree; `visible` short-circuits the
       * recursion, so this drops the walk and the draws together. Measured on a
       * day-421 shop at 5pm with 54 shoppers in it: `projectObject` 7.5% ->
       * 2.8%, `renderObject` 5.3% -> 2.9%, and the tab went from saturated to
       * 55% idle.
       *
       * Restored below, for the reason the matrix flag above is: these are
       * fields on somebody else's scene graph, and one left set is a crowd that
       * never draws again.
       */
      if (noCrease) for (const o of noCrease) o.visible = false;
      /**
       * ...and the far backdrop comes OUT, because this pass cannot see what
       * that band actually looks like.
       *
       * `overrideMaterial` replaces every material in the world, so neither the
       * haze that dissolves those mountains into the sky nor the sink that
       * lowers the near ones out of the shot exists here — the normals buffer
       * gets the raw geometry at full height. Left in, the contour draws a hard
       * black line round a peak that is ninety percent sky and round hills that
       * are not on screen at all, which reads as the drawing being broken.
       *
       * One layer off for one draw. See `SURROUND_LAYER` in lights.js, and note
       * the NEAR ridge is deliberately not on it: that one is solid, close, and
       * wants its lines like everything else in the shop.
       */
      camera.layers.disable(SURROUND_LAYER);
      // Nothing in a normals buffer is lit, so the shadow pass would be a THIRD
      // full draw of the shop for a map nothing samples. It is off for the
      // duration rather than left to the cadence, because `needsUpdate` has
      // already been consumed by the draw above.
      r.shadowMap.enabled = false;
      // Flat blue: the background reads as facing the camera, so the sky does
      // not draw a crease against itself and the silhouette is left to depth.
      r.setClearColor(0x8080ff, 1);
      r.setRenderTarget(this.rtNormal);
      r.clear();
      r.render(scene, camera);
      if (noCrease) for (const o of noCrease) o.visible = true;
      scene.matrixWorldAutoUpdate = autoMatrix;
      camera.layers.enable(SURROUND_LAYER);
      scene.overrideMaterial = null;
      scene.background = bg;
      scene.fog = fog;
      r.shadowMap.enabled = shadows;
      r.setClearColor(clear, alpha);
    }
    u.tNormal.value = wantsInk ? this.rtNormal.texture : this.blank;
    u.tNormalDepth.value = wantsInk ? this.rtNormal.depthTexture : this.blank;

    // 3 — the contour and the grade, in one go.
    u.tScene.value = this.rtScene.texture;
    u.tDepth.value = this.rtScene.depthTexture;
    u.near.value = camera.near;
    u.far.value = camera.far;
    u.isOrtho.value = camera.isOrthographicCamera ? 1 : 0;
    u.inkRef.value = inkRef;

    r.setRenderTarget(this.rtOut);
    r.clear();
    r.render(this.composite.scene, QUAD_CAM);

    // 4 — and the staircase off the ink, straight at the canvas.
    this.fxaa.mat.uniforms.tDiffuse.value = this.rtOut.texture;
    r.setRenderTarget(null);
    r.clear();
    r.render(this.fxaa.scene, QUAD_CAM);
  }

  dispose(targetsOnly = false) {
    for (const key of ['rtScene', 'rtNormal', 'rtOut']) {
      const rt = this[key];
      if (!rt) continue;
      rt.depthTexture?.dispose();
      rt.texture.dispose();
      rt.dispose();
      this[key] = null;
    }
    if (targetsOnly) return;
    this.w = 0;
    this.h = 0;
    this.blank.dispose();
    this.normalMat.dispose();
    this.composite.mat.dispose();
    this.fxaa.mat.dispose();
  }
}

/** Scratch for reading the clear colour back, which happens once a frame. */
const SCRATCH = new THREE.Color();
