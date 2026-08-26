/**
 * THE LAB'S RENDER PIPELINE — everything that happens after the shop is drawn.
 *
 * Hand-rolled rather than `EffectComposer`, for one reason that is not taste:
 * the ink pass needs the DEPTH BUFFER of the pass that drew the scene, and a
 * composer ping-pongs between two targets that share one depth attachment — so
 * the pass reading depth is reading the buffer it is also writing behind. Owning
 * the targets means the read and the write are never the same object, and it
 * costs about a hundred lines.
 *
 * Three buffers of scene, in order:
 *
 *   1. COLOUR + DEPTH — the shop, drawn once, into a half-float target so a
 *      neon sign can be brighter than white and bloom has something to find.
 *   2. NORMALS — the same shop drawn again through `MeshNormalMaterial`. This
 *      is the second full draw, so it is skipped outright when the ink is off.
 *   3. BLOOM — bright-pass into a half-size pair, blurred separably.
 *
 * ...then one fullscreen shader that does the contour, the grade, the duotone,
 * the halftone and the vignette in a single pass. One pass because every one of
 * those is a per-fragment lookup at the same texel, and chaining them through
 * five targets would be five full-screen bandwidth hits to express arithmetic
 * that fits in one function.
 *
 * The whole file is linear-light until the last line, where it converts to sRGB
 * by hand — three only does that conversion for its own materials, and a raw
 * `ShaderMaterial` writing to the canvas gets none of it. Skip that and every
 * colour in the lab is a different shade from the same colour in the game,
 * which reads as the style having changed something it never touched.
 */

import * as THREE from 'three';

/** Where a fullscreen pass lives. One quad, reused by all three shaders. */
const QUAD_GEO = new THREE.PlaneGeometry(2, 2);
const QUAD_CAM = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Anything above the threshold, and nothing else.
 *
 * A soft knee rather than a `step`, because a hard cut makes a surface that
 * drifts across the threshold pop on and off as the camera turns — which reads
 * as flickering art rather than as a bloom setting.
 */
const BRIGHT = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform float threshold;
  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float k = smoothstep(threshold, threshold + 0.35, l);
    gl_FragColor = vec4(c * k, 1.0);
  }
`;

/** Separable nine-tap gaussian. `dir` carries the axis and the step. */
const BLUR = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 dir;
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
    c += (texture2D(tSrc, vUv + dir * 1.3846).rgb + texture2D(tSrc, vUv - dir * 1.3846).rgb) * 0.316216;
    c += (texture2D(tSrc, vUv + dir * 3.2307).rgb + texture2D(tSrc, vUv - dir * 3.2307).rgb) * 0.070270;
    gl_FragColor = vec4(c, 1.0);
  }
`;

const COMPOSITE = /* glsl */`
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tScene;
  uniform sampler2D tDepth;
  uniform sampler2D tNormal;
  uniform sampler2D tBloom;
  uniform vec2 texel;

  uniform float near, far, isOrtho;

  uniform float inkAmount, inkSharp, inkFade, inkRef;
  uniform float silWidth, silThresh;
  uniform float creaseWidth, creaseThresh, creaseInk;
  uniform vec3 inkColor;

  uniform float exposure, saturation, contrast, posterize, paper;
  uniform vec3 paperColor;
  uniform float splitAmount;
  uniform vec3 shadowTint, highTint;

  uniform float bloomAmount;
  uniform float screenAmount, screenScale, screenAngle, screenMode, screenBias, vignette;
  uniform float paletteOn, paletteCount;
  uniform vec3 palette[6];
  uniform float misreg, grain;

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  /**
   * SNAP TO THE INKS YOU ACTUALLY HAVE.
   *
   * A screenprint is not a picture with fewer colours in it, it is a picture
   * made of a FIXED SET of colours — you buy the drums, and everything on the
   * page is one of them. Posterising quantises each channel independently,
   * which keeps the hue and just coarsens it; this replaces the colour outright
   * with the nearest ink, which is why a riso looks printed and a posterised
   * render looks compressed.
   *
   * Weighted toward green because that is most of what the eye reads as
   * brightness: unweighted, a dark red and a dark blue sit almost the same
   * distance from a dark ink and swap for each other as the camera turns, which
   * reads as the whole shop flickering.
   */
  vec3 lockPalette(vec3 c) {
    float best = 1e9;
    vec3 hit = c;
    for (int i = 0; i < 6; i++) {
      if (float(i) >= paletteCount) continue;
      vec3 d = (c - palette[i]) * vec3(1.0, 1.25, 0.75);
      float dist = dot(d, d);
      if (dist < best) { best = dist; hit = palette[i]; }
    }
    return hit;
  }

  /* Distance from the eye, in world units, whichever camera drew it. An ortho
     projection is already linear in depth; a perspective one is not, and the
     difference is the whole reason this takes a flag. */
  float viewDist(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    if (isOrtho > 0.5) return d * (far - near) + near;
    return (2.0 * near * far) / (far + near - (d * 2.0 - 1.0) * (far - near));
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
     rather than where the photons are. Mixed in linear, inkAmount describes a
     fraction of the ENERGY: half way to black leaves a surface at about 70% of
     its brightness, which is a grey smear rather than a stroke, and no value of
     the dial reads as ink because the dial is answering a different question.
     Mixed after the transfer, 0.53 is 53% coverage and looks like it. The round
     trip is what keeps the grain and the vignette below linear. */
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

  /* THE INTERIOR LINE. Where two faces of ONE object meet — a body seam, a
     wheel arch, the lip of a shelf. Depth cannot see these at all, because
     there is no step in depth to find, and they are the ones that want to be
     THIN. Two detectors and two widths is the whole difference between a
     drawing and a render with a border round it. */
  float creaseAt(vec2 uv, float w) {
    vec2 o = texel * w;
    vec3 nc = readNormal(uv);
    float ne = 0.0;
    ne = max(ne, 1.0 - dot(nc, readNormal(uv - vec2(o.x, 0.0))));
    ne = max(ne, 1.0 - dot(nc, readNormal(uv + vec2(o.x, 0.0))));
    ne = max(ne, 1.0 - dot(nc, readNormal(uv - vec2(0.0, o.y))));
    ne = max(ne, 1.0 - dot(nc, readNormal(uv + vec2(0.0, o.y))));
    return ne;
  }

  vec2 turn(vec2 v, float a) {
    float c = cos(a), s = sin(a);
    return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
  }

  void main() {
    vec3 col;
    if (misreg > 0.001) {
      /* MISREGISTRATION. Each drum lays its ink a hair off the last, so the
         edges fringe. Done as a per-channel offset on the way IN — the cheapest
         honest version, because the alternative is running the whole composite
         once per ink and compositing three passes for a two-pixel wobble. */
      vec2 o = texel * misreg;
      col = vec3(
        texture2D(tScene, vUv + vec2(o.x, o.y * 0.5)).r,
        texture2D(tScene, vUv).g,
        texture2D(tScene, vUv - vec2(o.x * 0.7, o.y)).b
      );
    } else {
      col = texture2D(tScene, vUv).rgb;
    }
    col *= exposure;
    if (bloomAmount > 0.001) col += texture2D(tBloom, vUv).rgb * bloomAmount;

    /* ---- the grade -------------------------------------------------------- */
    col = mix(vec3(dot(col, LUMA)), col, saturation);
    col = (col - 0.5) * contrast + 0.5;

    /* Split tone: one colour into the shadows, another into the lights. This is
       the whole of what makes a night scene read as CYBERPUNK rather than as a
       dark shop — the shadows have to be a colour somebody chose, not an
       absence, and no amount of neon in the lamps says that on its own. */
    if (splitAmount > 0.001) {
      float sl = clamp(dot(col, LUMA), 0.0, 1.0);
      col = mix(col, col * mix(shadowTint, highTint, sl) * 2.0, splitAmount);
    }

    if (posterize > 1.5) {
      float n = posterize - 1.0;
      col = floor(clamp(col, 0.0, 1.0) * n + 0.5) / n;
    }

    /* Two inks: the paper colour at the top end and the LINE colour at the
       bottom. (No backticks anywhere in these shaders — they are template
       literals, and a stray one ends the string with a JS error naming a GLSL
       word.) */
    /* The inks, after the grade and before anything drawn on top — the lines
       and the hatching are their own ink and must not be snapped to the set.
       The goods are exempt: their colour is what tells one board from the next,
       and a shop locked to five inks is unreadable rather than stylish. The
       mark rides in the frame's own alpha — see PROTECT_ALPHA in lab.js. */
    float keep = step(texture2D(tScene, vUv).a, 0.6);
    if (paletteOn > 0.001) {
      col = mix(col, mix(lockPalette(clamp(col, 0.0, 1.0)), col, keep), paletteOn);
    }

    if (paper > 0.001) {
      float pl = clamp(dot(col, LUMA), 0.0, 1.0);
      col = mix(col, mix(inkColor, paperColor, pl), paper);
    }

    /* ---- the screen, UNDER the line ---------------------------------------
       Hatching is drawn before the contour, because in a drawn panel the pen
       shading sits inside a shape and the outline is laid over the top of it.
       Screened afterwards, every line gets chewed into dashes and the whole
       thing reads as a bad print rather than as ink. */
    if (screenAmount > 0.001) {
      float a = radians(screenAngle);
      vec2 p = turn(gl_FragCoord.xy, a) / max(screenScale, 0.5);
      /* PAPER STAYS BLANK. Hatching is what a pen does in a SHADOW, not a
         texture laid over the whole panel — so nothing above the bias gets a
         stroke at all, and what is below it is re-spread across the full range
         so the darkest area still reaches solid fill. Without this the lit
         floor is finely hatched everywhere, which is not shading, it is a
         screen tone over the drawing. */
      float dark = clamp((1.0 - dot(col, LUMA) - screenBias) / max(0.001, 1.0 - screenBias), 0.0, 1.0);
      float m;
      if (screenMode < 0.5) {
        float r = length(fract(p) - 0.5);
        m = 1.0 - smoothstep(sqrt(dark) * 0.60, sqrt(dark) * 0.60 + 0.06, r);
      } else {
        /* Parallel strokes whose WIDTH is the darkness — which is how a pen
           actually does it, and is why this reads as hand-drawn where a dot
           screen reads as newsprint. */
        m = 1.0 - smoothstep(dark * 0.80, dark * 0.80 + 0.09, fract(p.x));
        /* ...crossed a second time once it is dark enough to need it. */
        if (dark > 0.60) {
          vec2 q = turn(gl_FragCoord.xy, a + 1.15) / max(screenScale, 0.5);
          float d2 = (dark - 0.60) * 2.2;
          m = max(m, 1.0 - smoothstep(d2 * 0.80, d2 * 0.80 + 0.09, fract(q.x)));
        }
      }
      col = mix(col, inkColor, screenAmount * m * dark);
    }

    /* ---- the contour, over everything -------------------------------------- */
    if (inkAmount > 0.001) {
      float dc = viewDist(vUv);
      /* Lines thin with distance, or the far half of a shop is a black mat.
         Referenced against the CAMERA'S OWN distance, which is the bug this
         replaced: a hard-coded 20 against an ortho camera parked at 70 put
         every line in the shop on the 0.3 clamp for ever, so the fade dial only
         ever said "thin" and the ink drew at about a third of what was
         authored. An ortho projection has no perspective, so the reference
         plane is the only thing "distance" can honestly mean here. */
      float scale = mix(1.0, clamp(inkRef / max(dc, 0.001), 0.35, 1.6), inkFade);
      /* How soft the edge of the LINE is, which is not how thick it is. A wide
         soft line is a grey smear; a wide hard one is a brush stroke. Thickness
         is the sample offset, and this is only the falloff. */
      float soft = mix(0.015, 0.40, inkSharp);
      float s = smoothstep(silThresh, silThresh + soft, silAt(vUv, silWidth * scale) * 5.0);
      float c = smoothstep(creaseThresh, creaseThresh + soft, creaseAt(vUv, creaseWidth * scale) * 1.35);
      col = lay(col, inkColor, max(s, c * creaseInk) * inkAmount);
    }

    /* The paper itself, over the top of every ink on it. */
    if (grain > 0.001) {
      float n = hash21(floor(gl_FragCoord.xy)) - 0.5;
      col += n * grain * 0.35;
    }

    if (vignette > 0.001) {
      float v = smoothstep(0.90, 0.28, length(vUv - 0.5));
      col *= mix(1.0, v, vignette);
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
 * declarations and the precision line, which is all these three need — and it
 * is also what does the GLSL1-to-GLSL3 rewrite on WebGL2, which is why the
 * shaders above can be written in the old dialect.
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

/**
 * A half-float colour target with a real depth texture hanging off it.
 *
 * Half-float and not byte, because the whole neon idea rests on a value above
 * 1 surviving as far as the bright-pass. In eight bits it is clipped to white
 * on the way into the buffer and bloom has nothing left to separate it from a
 * white wall.
 */
function sceneTarget(w, h, filter) {
  const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
  depth.format = THREE.DepthFormat;
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: true,
    depthTexture: depth,
  });
}

function plainTarget(w, h, filter, type = THREE.HalfFloatType) {
  return new THREE.WebGLRenderTarget(w, h, {
    type,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: false,
  });
}

export class Pipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.w = 1;
    this.h = 1;
    this.chunky = -1;

    /* One flat blue pixel, which decodes to a normal pointing straight at the
       camera. It stands in for the normal buffer whenever the ink is off, so
       the composite shader never has to branch on whether the texture exists —
       an unbound sampler is undefined behaviour, not a black texture. */
    this.blank = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    this.blank.needsUpdate = true;
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;

    // No `fog` on it — the normal material has no such property, and the pass
    // takes the fog off the scene for the duration anyway. Fogged normals would
    // fade every crease in the far half of the shop, which is a contour that
    // thins with distance for a reason nobody chose.
    this.normalMat = new THREE.MeshNormalMaterial({ flatShading: true });

    /** One Color, reused, for converting palette hexes into working space. */
    this.scratch = new THREE.Color();

    this.bright = quad(BRIGHT, {
      tScene: { value: null },
      threshold: { value: 0.7 },
    });
    this.blur = quad(BLUR, {
      tSrc: { value: null },
      dir: { value: new THREE.Vector2() },
    });
    this.composite = quad(COMPOSITE, {
      tScene: { value: null },
      tDepth: { value: null },
      tNormal: { value: this.blank },
      tBloom: { value: this.black },
      texel: { value: new THREE.Vector2() },
      near: { value: 0.5 },
      far: { value: 200 },
      isOrtho: { value: 1 },
      inkAmount: { value: 0 },
      inkSharp: { value: 0.15 },
      inkRef: { value: 70 },
      inkFade: { value: 0.5 },
      silWidth: { value: 1.6 },
      silThresh: { value: 0.3 },
      creaseWidth: { value: 0.9 },
      creaseThresh: { value: 0.55 },
      creaseInk: { value: 0.6 },
      inkColor: { value: new THREE.Color('#171219') },
      exposure: { value: 1 },
      saturation: { value: 1 },
      contrast: { value: 1 },
      posterize: { value: 0 },
      paper: { value: 0 },
      paperColor: { value: new THREE.Color('#fff4e0') },
      splitAmount: { value: 0 },
      shadowTint: { value: new THREE.Color('#3a2a6b') },
      highTint: { value: new THREE.Color('#ffd9a6') },
      bloomAmount: { value: 0 },
      screenAmount: { value: 0 },
      screenScale: { value: 4 },
      screenAngle: { value: 25 },
      screenMode: { value: 0 },
      screenBias: { value: 0.45 },
      vignette: { value: 0 },
      paletteOn: { value: 0 },
      paletteCount: { value: 4 },
      // A flat Float32Array rather than an array of Colors: three flattens
      // either, but only this one is guaranteed not to reallocate per frame.
      palette: { value: new Float32Array(18) },
      misreg: { value: 0 },
      grain: { value: 0 },
    });
  }

  /** Sized in DEVICE pixels, then divided by `chunky` — see `DEFAULTS.chunky`. */
  setSize(w, h, chunky) {
    const div = 1 + Math.max(0, chunky) * 1.6;
    const rw = Math.max(2, Math.round(w / div));
    const rh = Math.max(2, Math.round(h / div));
    if (rw === this.w && rh === this.h && chunky === this.chunky) return;
    this.w = rw;
    this.h = rh;
    this.chunky = chunky;

    const filter = chunky > 0 ? THREE.NearestFilter : THREE.LinearFilter;
    this.dispose(true);
    this.rtScene = sceneTarget(rw, rh, filter);
    this.rtNormal = plainTarget(rw, rh, THREE.NearestFilter, THREE.UnsignedByteType);
    const bw = Math.max(2, rw >> 1);
    const bh = Math.max(2, rh >> 1);
    this.rtBloomA = plainTarget(bw, bh, THREE.LinearFilter);
    this.rtBloomB = plainTarget(bw, bh, THREE.LinearFilter);

    this.composite.mat.uniforms.texel.value.set(1 / rw, 1 / rh);
  }

  render(scene, camera, S) {
    const r = this.renderer;
    const u = this.composite.mat.uniforms;

    // 1 — the shop, once.
    r.setRenderTarget(this.rtScene);
    r.clear();
    r.render(scene, camera);

    // 2 — its normals, but only if anybody is going to read them.
    const wantsInk = S.inkAmount > 0.001;
    if (wantsInk) {
      const bg = scene.background;
      const fog = scene.fog;
      const clear = r.getClearColor(new THREE.Color());
      const alpha = r.getClearAlpha();
      scene.background = null;
      scene.fog = null;
      scene.overrideMaterial = this.normalMat;
      // Flat blue: the background reads as facing the camera, so the sky does
      // not draw a crease against itself and the silhouette is left to depth.
      r.setClearColor(0x8080ff, 1);
      r.setRenderTarget(this.rtNormal);
      r.clear();
      r.render(scene, camera);
      scene.overrideMaterial = null;
      scene.background = bg;
      scene.fog = fog;
      r.setClearColor(clear, alpha);
    }
    u.tNormal.value = wantsInk ? this.rtNormal.texture : this.blank;

    // 3 — bloom, likewise skipped whole when it is off.
    const wantsBloom = S.bloom > 0.001;
    if (wantsBloom) {
      this.bright.mat.uniforms.tScene.value = this.rtScene.texture;
      this.bright.mat.uniforms.threshold.value = S.bloomThresh;
      r.setRenderTarget(this.rtBloomA);
      r.clear();
      r.render(this.bright.scene, QUAD_CAM);

      const spread = Math.max(0.3, S.bloomSpread);
      const bw = this.rtBloomA.width;
      const bh = this.rtBloomA.height;
      for (let i = 0; i < 3; i++) {
        const step = spread * (1 + i * 1.7);
        this.blur.mat.uniforms.tSrc.value = this.rtBloomA.texture;
        this.blur.mat.uniforms.dir.value.set(step / bw, 0);
        r.setRenderTarget(this.rtBloomB);
        r.clear();
        r.render(this.blur.scene, QUAD_CAM);

        this.blur.mat.uniforms.tSrc.value = this.rtBloomB.texture;
        this.blur.mat.uniforms.dir.value.set(0, step / bh);
        r.setRenderTarget(this.rtBloomA);
        r.clear();
        r.render(this.blur.scene, QUAD_CAM);
      }
    }
    u.tBloom.value = wantsBloom ? this.rtBloomA.texture : this.black;

    // 4 — everything else, in one go, straight at the canvas.
    u.tScene.value = this.rtScene.texture;
    u.tDepth.value = this.rtScene.depthTexture;
    u.near.value = camera.near;
    u.far.value = camera.far;
    u.isOrtho.value = camera.isOrthographicCamera ? 1 : 0;

    u.inkAmount.value = S.inkAmount;
    u.inkSharp.value = S.inkSharp;
    u.inkRef.value = camera.position.length();
    u.inkFade.value = S.inkFade;
    u.silWidth.value = S.silWidth;
    u.silThresh.value = S.silThresh;
    u.creaseWidth.value = S.creaseWidth;
    u.creaseThresh.value = S.creaseThresh;
    u.creaseInk.value = S.creaseInk;
    u.inkColor.value.set(S.inkColor);
    u.exposure.value = S.exposure;
    u.saturation.value = S.saturation;
    u.contrast.value = S.contrast;
    u.posterize.value = S.posterize;
    u.paper.value = S.paper;
    u.paperColor.value.set(S.paperColor);
    u.splitAmount.value = S.splitAmount;
    u.shadowTint.value.set(S.shadowTint);
    u.highTint.value.set(S.highTint);
    u.bloomAmount.value = wantsBloom ? S.bloom : 0;
    u.screenAmount.value = S.screenAmount;
    u.screenScale.value = S.screenScale;
    u.screenAngle.value = S.screenAngle;
    u.screenMode.value = S.screenMode === 'hatch' ? 1 : 0;
    u.screenBias.value = S.screenBias;
    u.vignette.value = S.vignette;
    u.misreg.value = S.misreg;
    u.grain.value = S.grain;

    u.paletteOn.value = S.paletteOn;
    u.paletteCount.value = S.paletteCount;
    // Written in place through a scratch Color so the shader's working space
    // matches every other colour here — three converts a material colour from
    // sRGB on the way in and does not convert a raw uniform, so a hex written
    // straight into the array would print a different shade of its own ink.
    for (let i = 0; i < 6; i++) {
      this.scratch.set(S[`pal${i}`] ?? '#000000');
      u.palette.value[i * 3] = this.scratch.r;
      u.palette.value[i * 3 + 1] = this.scratch.g;
      u.palette.value[i * 3 + 2] = this.scratch.b;
    }

    r.setRenderTarget(null);
    r.clear();
    r.render(this.composite.scene, QUAD_CAM);
  }

  dispose(targetsOnly = false) {
    for (const key of ['rtScene', 'rtNormal', 'rtBloomA', 'rtBloomB']) {
      const rt = this[key];
      if (!rt) continue;
      rt.depthTexture?.dispose();
      rt.texture.dispose();
      rt.dispose();
      this[key] = null;
    }
    if (targetsOnly) return;
    this.blank.dispose();
    this.black.dispose();
    this.normalMat.dispose();
    for (const q of [this.bright, this.blur, this.composite]) q.mat.dispose();
  }
}
