/**
 * THE STYLE LAB — what there is to turn, and the looks worth starting from.
 *
 * Nothing in here is imported by the game. The lab is a second page on the dev
 * server (`/lab.html`) that reads the real art out of `client/render/props.js`
 * and `data/seed/*.json` and draws it through a pipeline of its own, so a look
 * can be argued about before a single renderer file is touched.
 *
 * The split is the point. A STYLE is a bag of numbers and a SET is a bag of
 * geometry, and neither knows about the other — so every look can be judged
 * against an aisle, a shopfront, the whole catalog and a farm without anybody
 * re-authoring anything. A style that only works on the set it was tuned
 * against is the failure this is here to catch.
 */

/**
 * Every knob, at the values that reproduce the game as it ships today.
 *
 * This is the control, and it earns its place the way every `verify:*` control
 * does: a preset that cannot be told from `stock` in a screenshot is a preset
 * that changes nothing, and the only way to know is to have the real thing one
 * key away.
 */
export const DEFAULTS = {
  // --- shading -----------------------------------------------------------
  /** `stock` is Lambert flat-shading; `unlit` is a flat fill; `toon` bands it. */
  shading: 'stock',
  bands: 3,
  /** How dark the bottom band is. At 0 a shadow is the object's own colour
   *  turned down, which is shading; near 0 with a white base it is a filled
   *  BLOCK, which is what a drawn panel does instead of shading. */
  shadowFloor: 0,
  /** How far every surface is washed toward `washColor`. At 1 the shop is
   *  painted flat white and the only thing left on it is the ink. */
  wash: 0,
  washColor: '#ffffff',
  /** Goods, crops and people keep their own colour whatever the shop wears —
   *  see `markKeep` in lab.js. Off is what "too muted" looked like. */
  protectGoods: true,
  /** Whether fixtures take the sun's shadow on themselves as well as the floor. */
  receive: true,
  shadowHard: false,
  shadows: true,

  // --- light -------------------------------------------------------------
  ambient: 0.90,
  ambientColor: '#ffffff',
  sun: 1.15,
  sunColor: '#fff4dd',
  bounce: 0.32,
  bounceColor: '#bcd8ff',
  sunAngle: 28,
  sunHeight: 40,
  /** The shop's OWN lamps, off the pieces' `emits` blocks. Scales all of them
   *  at once; the individual brightnesses are authored content. */
  lamps: 1,
  /** ...and how far their AUTHORED colour is pulled toward the two below, which
   *  alternate. Every lamp in the catalog is warm, so this is the only way to a
   *  street that argues with itself. 0 leaves the content alone. */
  lampTint: 0,
  lampA: '#ff3fa4',
  lampB: '#2fe6ff',

  // --- ink ---------------------------------------------------------------
  /** How much of the contour to draw. 0 is off, and off costs a whole pass. */
  inkAmount: 0,
  /**
   * TWO WEIGHTS, which is the thing a single-width outline can never be.
   * `sil` is the outer line — where one object ends and another begins — and
   * wants to be thick. `crease` is the interior line — a seam, a lip, a wheel
   * arch — and wants to be thin and lighter. Merge them into one number and you
   * get a render with a border round it rather than a drawing.
   */
  silWidth: 2.0,
  silThresh: 0.28,
  creaseWidth: 0.85,
  creaseThresh: 0.50,
  /** How dark an interior line is against the outer one. */
  creaseInk: 0.55,
  /** How soft the EDGE of a line is — not how thick. A wide soft line is a grey
   *  smear, which is what "blurry" was; a wide hard one is a brush stroke. */
  inkSharp: 0.10,
  /** How much thinner a line gets as it goes away. 0 draws the far shop as
   *  heavily as the near shelf, which is what makes a busy floor read as mud. */
  inkFade: 0.55,
  inkColor: '#171219',

  // --- colour ------------------------------------------------------------
  exposure: 1.0,
  saturation: 1.0,
  contrast: 1.0,
  /** 0 is off; 2..8 is that many levels per channel. */
  posterize: 0,
  /** A duotone toward `paperColor` at the top and `inkColor` at the bottom.
   *  At 1 the whole picture is two inks, which is the black-and-white look. */
  paper: 0,
  paperColor: '#fff4e0',
  /** One colour into the shadows, another into the lights. The half that makes
   *  a dark shop read as cyberpunk rather than as a shop with the lights off. */
  splitAmount: 0,
  shadowTint: '#3a2a6b',
  highTint: '#ffd9a6',

  /**
   * THE INKS. Every colour on screen snapped to the nearest of these, which is
   * a different thing from posterising: a print has a fixed set of drums, and
   * everything on the page is one of them. `paletteCount` says how many of the
   * six below are loaded.
   */
  paletteOn: 0,
  paletteCount: 4,
  pal0: '#f4eee0',
  pal1: '#ff4899',
  pal2: '#0f5dbb',
  pal3: '#2b2438',
  pal4: '#ffcc22',
  pal5: '#6a8f8a',
  /** How far the drums sit off each other, in pixels. */
  misreg: 0,
  /** The paper, over the top of every ink on it. */
  grain: 0,

  // --- bloom -------------------------------------------------------------
  bloom: 0,
  bloomThresh: 0.72,
  bloomSpread: 1.0,
  /** Multiplies anything authored `glow` — a sign, a lamp lens, a neon tube.
   *  Above 1 it pushes past white, which is what gives bloom something to find. */
  glowBoost: 1.0,

  // --- screen ------------------------------------------------------------
  /** `dots` is newsprint; `hatch` is parallel pen strokes that cross once the
   *  shadow is dark enough to need it, which is what a manga panel actually
   *  does and is the difference between hand-drawn and photocopied. */
  screenMode: 'hatch',
  screenAmount: 0,
  screenScale: 4.0,
  screenAngle: 25,
  /** How dark a thing has to be before a stroke appears on it at all. This is
   *  what keeps lit surfaces as blank paper — at 0 the whole panel is hatched,
   *  which is a screen tone laid over a drawing rather than shading in one. */
  screenBias: 0.45,
  vignette: 0,
  /** Renders the whole scene smaller and blows it back up with no filtering. */
  chunky: 0,

  // --- world -------------------------------------------------------------
  skyTop: '#cfe9f5',
  skyLow: '#f2f7fa',
  fog: 0,
  fogColor: '#cfe9f5',
  ground: true,

  // --- camera ------------------------------------------------------------
  zoom: 1.0,
  yaw: 45,
  pitch: 40,
  spin: false,
};

/**
 * The looks worth starting an argument from.
 *
 * Each is a PATCH over `DEFAULTS` rather than a full set of values, so a knob
 * nobody thought about in a preset stays at the shipped number — which means
 * the diff between a preset and the game is exactly what is written here, and
 * you can read what a look costs by reading the object.
 */
export const PRESETS = {
  stock: {
    label: 'Stock',
    note: 'The game exactly as it ships. The control.',
    patch: {},
  },

  manga: {
    label: 'Manga',
    note: 'Flat white paper, thick outer line, thin seams, filled shadow blocks, pen hatching.',
    patch: {
      // The paper. Everything painted flat white so the only thing on the shop
      // is the drawing — and the shadow band filled near-black so it reads as
      // an ink block rather than as the same object in worse light.
      shading: 'toon', bands: 2, shadowFloor: 0.35,
      wash: 0.90, washColor: '#ffffff',
      shadowHard: true, receive: true,
      /**
       * THE LIGHT IS DELIBERATELY WEAK, and this is the number that was wrong
       * first time. A cast shadow drops a surface to AMBIENT ALONE — the toon
       * ramp and the shadow map both multiply the same sun term — so a low
       * ambient under a strong sun posterises every shaded face to solid black,
       * and whole shelves disappear into one blob. The drawing has to be the
       * LINES; shadow is a mid tone that the hatching then bites into.
       */
      ambient: 0.38, sun: 0.85, bounce: 0.04, lamps: 0,
      sunAngle: 40, sunHeight: 42,
      // Thick outside, thin inside, hard edged. All three or it is a render
      // with a border round it.
      inkAmount: 1,
      silWidth: 2.4, silThresh: 0.18,
      creaseWidth: 0.75, creaseThresh: 0.30, creaseInk: 0.72,
      inkSharp: 0.03, inkFade: 0.40, inkColor: '#0d0b12',
      contrast: 1.15, saturation: 0, posterize: 4,
      screenMode: 'hatch', screenAmount: 1, screenScale: 4.2, screenAngle: 34, screenBias: 0.60,
      skyTop: '#ffffff', skyLow: '#f4f2ee',
    },
  },

  cel: {
    label: 'Cel + Ink',
    note: 'The chosen one. Hard light bands, a fine hard contour, full colour.',
    /**
     * TUNED BY HAND, and the ink block is the part that was found rather than
     * reasoned to — so change it against a screenshot, not against an argument.
     *
     * What the numbers say: catch almost EVERY edge (`silThresh` 0.07, very
     * low), draw the outer line thick but the creases hair-fine (3.0 against
     * 0.2), perfectly hard (`inkSharp` 0), and then pull the whole lot back to
     * half strength. The result is a drawn line over the entire shop rather
     * than a heavy outline round the near things — which is why `inkFade` is
     * also low: the far half of the aisle is meant to keep its lines.
     *
     * It is full colour on purpose. Every look that traded colour away — the
     * ink lock, the paper wash — was rejected for the same reason, and it is a
     * playability one rather than a taste one: colour is how a board of apples
     * is told from a board of carrots across the shop. See `markKeep` in lab.js.
     */
    patch: {
      // `shadowHard` off, and it is the one number here that was decided in the
      // shop rather than in the lab. This set has no face standing near-parallel
      // to its own sun; the shop's `+z` wall does, and unfiltered every bit of
      // self-shadowing on it becomes a binary lattice. Hardness comes from the
      // texel — see `SHADOW_SPAN_MIN` in client/render/look.js.
      shading: 'toon', bands: 3, shadowFloor: 0.22, shadowHard: false,
      ambient: 0.62, sun: 1.45, bounce: 0.24,
      inkAmount: 0.53,
      // Tuned at PLAY zoom, not at this set's default 4. Width is in screen
      // texels, so a number found three times closer than the game is ever
      // played draws a fine line here and a fat one in the shop.
      silWidth: 1.4, silThresh: 0.07,
      creaseWidth: 0.2, creaseThresh: 0.49, creaseInk: 0.39,
      inkSharp: 0, inkFade: 0.29,
      saturation: 1.22, contrast: 1.08,
      skyTop: '#bfe4f2', skyLow: '#eaf6fb',
    },
  },

  sable: {
    label: 'Sable',
    note: 'Cel + Ink on a locked five-colour palette, warm ink, no cast shadows.',
    patch: {
      // No cast shadows at all, which is most of the look: the form comes from
      // the flat colour blocks and the line, so a shadow is just a smudge that
      // was not drawn. `shadowFloor` high for the same reason — the shaded band
      // is a second colour, not a darker one.
      shading: 'toon', bands: 2, shadowFloor: 0.62, shadows: false,
      ambient: 0.66, ambientColor: '#fff2d8', sun: 0.85, sunColor: '#ffe6bb',
      bounce: 0.22, bounceColor: '#cbb9ff', lamps: 0.6,
      inkAmount: 1,
      silWidth: 1.9, silThresh: 0.22,
      creaseWidth: 0.7, creaseThresh: 0.36, creaseInk: 0.55,
      inkSharp: 0.05, inkFade: 0.5,
      // Warm brown rather than black: a pen line on tinted paper, not print.
      inkColor: '#4a3040',
      saturation: 1.0, contrast: 1.04,
      paletteOn: 0.92, paletteCount: 5,
      pal0: '#f7e7c3', pal1: '#e8b271', pal2: '#c2694a',
      pal3: '#4a3040', pal4: '#7d9c92',
      grain: 0.16,
      skyTop: '#f6d9a4', skyLow: '#fbeed2',
    },
  },

  riso: {
    label: 'Risograph',
    note: 'Four drums, off by two pixels, on grainy paper. Fluoro pink and blue.',
    patch: {
      shading: 'toon', bands: 2, shadowFloor: 0.48, shadowHard: true,
      ambient: 0.54, sun: 1.0, bounce: 0.12, lamps: 0.5,
      sunAngle: 40, sunHeight: 44,
      inkAmount: 0.9,
      silWidth: 1.9, silThresh: 0.24,
      creaseWidth: 0.7, creaseThresh: 0.40, creaseInk: 0.5,
      inkSharp: 0.04, inkFade: 0.4, inkColor: '#2b2438',
      saturation: 1.15, contrast: 1.06,
      // The drums. Paper, fluoro pink, riso blue, near-black.
      paletteOn: 1, paletteCount: 4,
      pal0: '#f4eee0', pal1: '#ff4899', pal2: '#0f5dbb', pal3: '#2b2438',
      misreg: 2.4, grain: 0.42,
      // A light dot screen on top, because a riso lays flat ink and gets its
      // mid-tones from the screen rather than from a lighter colour.
      screenMode: 'dots', screenAmount: 0.5, screenScale: 3.6,
      screenAngle: 45, screenBias: 0.42,
      skyTop: '#f4eee0', skyLow: '#faf6ec',
    },
  },

  flat: {
    label: 'Ink + Flat',
    note: 'The cel-shaded car in colour: one flat fill, one hard shadow shape, black lines.',
    patch: {
      shading: 'toon', bands: 2, shadowFloor: 0.30, shadowHard: true, receive: true,
      wash: 0.28,
      ambient: 0.90, sun: 1.0, bounce: 0.06,
      inkAmount: 1,
      silWidth: 3.0, silThresh: 0.20,
      creaseWidth: 0.75, creaseThresh: 0.44, creaseInk: 0.7,
      inkSharp: 0.02, inkFade: 0.3,
      saturation: 1.35, contrast: 1.18, posterize: 5,
      skyTop: '#e8f4fa', skyLow: '#f9fdff',
    },
  },

  neon: {
    label: 'Neon Noir',
    note: 'Magenta and cyan arguing. Split-toned shadows, tinted lamps, hard bloom.',
    patch: {
      shading: 'toon', bands: 3, shadowFloor: 0.05, shadowHard: false,
      ambient: 0.16, ambientColor: '#5b6fd8',
      sun: 0.16, sunColor: '#4f6ad0', bounce: 0.30, bounceColor: '#ff2f9a',
      // The lamps stop being a shop at dusk and start being a street.
      lamps: 2.3, lampTint: 0.92, lampA: '#ff2f9a', lampB: '#25e8ff',
      inkAmount: 0.85,
      silWidth: 1.8, silThresh: 0.30,
      creaseWidth: 0.7, creaseThresh: 0.55, creaseInk: 0.35,
      inkSharp: 0.05, inkColor: '#05030d',
      saturation: 1.75, contrast: 1.22, exposure: 1.1,
      // The half that actually says cyberpunk: the shadows are a colour
      // somebody chose rather than an absence.
      splitAmount: 0.85, shadowTint: '#2b1a63', highTint: '#48f0ff',
      bloom: 1.9, bloomThresh: 0.40, bloomSpread: 1.9, glowBoost: 4.5,
      vignette: 0.62,
      skyTop: '#04030c', skyLow: '#3a0f4d',
      fog: 0.42, fogColor: '#180a33',
    },
  },

  chunky: {
    label: 'Chunky',
    note: 'The shipped look through a smaller window. Pixel art without redrawing any.',
    patch: {
      chunky: 3,
      inkAmount: 0.8, silWidth: 1.0, creaseWidth: 0.6, creaseInk: 0.4,
      inkSharp: 0, inkFade: 0,
      saturation: 1.2, contrast: 1.1, posterize: 8,
    },
  },
};

/**
 * The rail, in the order it reads top to bottom.
 *
 * `when` hides a control whose parent is off — a bloom radius under a bloom of
 * zero is a knob that takes a press and moves no pixel, which is this repo's
 * oldest complaint about a tier ladder said about a slider.
 */
export const CONTROLS = [
  {
    group: 'Shading',
    items: [
      { key: 'shading', label: 'Surface', type: 'select', options: [
        ['stock', 'Stock (Lambert)'], ['unlit', 'Unlit flat'], ['toon', 'Toon bands'],
      ] },
      { key: 'bands', label: 'Bands', type: 'range', min: 2, max: 6, step: 1, when: (s) => s.shading === 'toon' },
      { key: 'shadowFloor', label: 'Shadow block', type: 'range', min: 0, max: 0.9, step: 0.01, when: (s) => s.shading === 'toon' },
      { key: 'wash', label: 'Paper wash', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'protectGoods', label: 'Goods keep colour', type: 'toggle' },
      { key: 'washColor', label: 'Paper', type: 'color', when: (s) => s.wash > 0 },
      { key: 'shadows', label: 'Cast shadows', type: 'toggle' },
      { key: 'shadowHard', label: 'Hard edged', type: 'toggle', when: (s) => s.shadows },
      { key: 'receive', label: 'Shadows on fixtures', type: 'toggle', when: (s) => s.shadows },
    ],
  },
  {
    group: 'Light',
    items: [
      { key: 'ambient', label: 'Ambient', type: 'range', min: 0, max: 2, step: 0.01 },
      { key: 'ambientColor', label: 'Ambient tint', type: 'color' },
      { key: 'sun', label: 'Sun', type: 'range', min: 0, max: 3, step: 0.01 },
      { key: 'sunColor', label: 'Sun colour', type: 'color' },
      { key: 'sunAngle', label: 'Sun bearing', type: 'range', min: 0, max: 360, step: 1 },
      { key: 'sunHeight', label: 'Sun height', type: 'range', min: 5, max: 85, step: 1 },
      { key: 'bounce', label: 'Bounce', type: 'range', min: 0, max: 1.5, step: 0.01 },
      { key: 'bounceColor', label: 'Bounce colour', type: 'color' },
      { key: 'lamps', label: 'Shop lamps', type: 'range', min: 0, max: 2.5, step: 0.01 },
      { key: 'lampTint', label: 'Lamp tint', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'lampA', label: 'Tint A', type: 'color', when: (s) => s.lampTint > 0 },
      { key: 'lampB', label: 'Tint B', type: 'color', when: (s) => s.lampTint > 0 },
    ],
  },
  {
    group: 'Ink',
    items: [
      { key: 'inkAmount', label: 'Line strength', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'silWidth', label: 'Outer thickness', type: 'range', min: 0.3, max: 6, step: 0.05, when: (s) => s.inkAmount > 0 },
      { key: 'silThresh', label: 'Outer catch', type: 'range', min: 0.02, max: 1.2, step: 0.01, when: (s) => s.inkAmount > 0 },
      { key: 'creaseWidth', label: 'Inner thickness', type: 'range', min: 0.2, max: 4, step: 0.05, when: (s) => s.inkAmount > 0 },
      { key: 'creaseThresh', label: 'Inner catch', type: 'range', min: 0.02, max: 1.2, step: 0.01, when: (s) => s.inkAmount > 0 },
      { key: 'creaseInk', label: 'Inner darkness', type: 'range', min: 0, max: 1, step: 0.01, when: (s) => s.inkAmount > 0 },
      { key: 'inkSharp', label: 'Softness', type: 'range', min: 0, max: 1, step: 0.01, when: (s) => s.inkAmount > 0 },
      { key: 'inkFade', label: 'Thin with distance', type: 'range', min: 0, max: 1, step: 0.01, when: (s) => s.inkAmount > 0 },
      { key: 'inkColor', label: 'Ink', type: 'color', when: (s) => s.inkAmount > 0 },
    ],
  },
  {
    group: 'Colour',
    items: [
      { key: 'exposure', label: 'Exposure', type: 'range', min: 0.2, max: 2.5, step: 0.01 },
      { key: 'saturation', label: 'Saturation', type: 'range', min: 0, max: 2.5, step: 0.01 },
      { key: 'contrast', label: 'Contrast', type: 'range', min: 0.4, max: 2, step: 0.01 },
      { key: 'posterize', label: 'Posterise', type: 'range', min: 0, max: 12, step: 1 },
      { key: 'paper', label: 'Duotone', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'paperColor', label: 'Duotone paper', type: 'color', when: (s) => s.paper > 0 },
      { key: 'splitAmount', label: 'Split tone', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'shadowTint', label: 'Shadows', type: 'color', when: (s) => s.splitAmount > 0 },
      { key: 'highTint', label: 'Highlights', type: 'color', when: (s) => s.splitAmount > 0 },
    ],
  },
  {
    group: 'Inks',
    items: [
      { key: 'paletteOn', label: 'Lock to inks', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'paletteCount', label: 'How many', type: 'range', min: 2, max: 6, step: 1, when: (s) => s.paletteOn > 0 },
      ...[0, 1, 2, 3, 4, 5].map((i) => ({
        key: `pal${i}`,
        label: `Ink ${i + 1}`,
        type: 'color',
        when: (s) => s.paletteOn > 0 && s.paletteCount > i,
      })),
      { key: 'misreg', label: 'Misregistration', type: 'range', min: 0, max: 8, step: 0.1 },
      { key: 'grain', label: 'Paper grain', type: 'range', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    group: 'Glow',
    items: [
      { key: 'glowBoost', label: 'Neon boost', type: 'range', min: 0.2, max: 6, step: 0.05 },
      { key: 'bloom', label: 'Bloom', type: 'range', min: 0, max: 3, step: 0.01 },
      { key: 'bloomThresh', label: 'Threshold', type: 'range', min: 0, max: 1.5, step: 0.01, when: (s) => s.bloom > 0 },
      { key: 'bloomSpread', label: 'Spread', type: 'range', min: 0.3, max: 3, step: 0.05, when: (s) => s.bloom > 0 },
    ],
  },
  {
    group: 'Screen',
    items: [
      { key: 'screenMode', label: 'Screen', type: 'select', options: [['hatch', 'Pen hatching'], ['dots', 'Halftone dots']] },
      { key: 'screenAmount', label: 'Strength', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'screenScale', label: 'Stroke size', type: 'range', min: 1.5, max: 14, step: 0.1, when: (s) => s.screenAmount > 0 },
      { key: 'screenAngle', label: 'Angle', type: 'range', min: 0, max: 90, step: 1, when: (s) => s.screenAmount > 0 },
      { key: 'screenBias', label: 'Blank paper above', type: 'range', min: 0, max: 0.9, step: 0.01, when: (s) => s.screenAmount > 0 },
      { key: 'vignette', label: 'Vignette', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'chunky', label: 'Pixelate', type: 'range', min: 0, max: 6, step: 1 },
    ],
  },
  {
    group: 'World',
    items: [
      { key: 'skyTop', label: 'Sky', type: 'color' },
      { key: 'skyLow', label: 'Horizon', type: 'color' },
      { key: 'fog', label: 'Fog', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'fogColor', label: 'Fog colour', type: 'color', when: (s) => s.fog > 0 },
      { key: 'ground', label: 'Ground', type: 'toggle' },
    ],
  },
  {
    group: 'Camera',
    items: [
      { key: 'zoom', label: 'Zoom', type: 'range', min: 0.35, max: 4, step: 0.01 },
      { key: 'yaw', label: 'Turn', type: 'range', min: 0, max: 360, step: 1 },
      { key: 'pitch', label: 'Tilt', type: 'range', min: 8, max: 88, step: 1 },
      { key: 'spin', label: 'Turntable', type: 'toggle' },
    ],
  },
];

/**
 * WHAT IS ON SCREEN — geometry only, no style anywhere in here.
 *
 * `id` names a row in `data/seed/fixtures.json`, so these are the shop's own
 * pieces rather than stand-ins. `t` is the tier the model is resolved at, which
 * matters because a tier is a stage of the art: judging a style against tier 1
 * of everything is judging half the catalog.
 *
 * `goods` names rows in `data/seed/items.json` and fills the unit's authored
 * boards, because a style that looks wonderful on empty shelving is a style
 * nobody will ever see — the shop is full of small round objects and they are
 * most of what an outline pass has to survive.
 */
export const SETS = {
  aisle: {
    label: 'Aisle',
    note: 'Two runs facing each other, stocked, with people in it.',
    ground: 'floor',
    walls: { kind: 'room', w: 11.5, d: 9.5 },
    camera: { zoom: 1.6, yaw: 45, pitch: 40 },
    fixtures: [
      { id: 'shelf', x: -3, z: -2, rot: 0, t: 1, goods: 'bread', qty: 12 },
      { id: 'shelf', x: -3, z: -1, rot: 0, t: 1, goods: 'cereal-box', qty: 10 },
      { id: 'shelf', x: -3, z: 0, rot: 0, t: 0.5, goods: 'chocolate', qty: 7 },
      { id: 'gondola', x: -3, z: 1, rot: 0, t: 1, goods: 'dried-pasta', qty: 14 },
      { id: 'shelf', x: 0, z: -2, rot: 180, t: 1, goods: 'apple', qty: 16 },
      { id: 'produce-table', x: 0, z: -1, rot: 180, t: 1, goods: 'carrot', qty: 18 },
      { id: 'produce-table', x: 0, z: 0, rot: 180, t: 1, goods: 'chilli', qty: 9 },
      { id: 'shelf', x: 0, z: 1, rot: 180, t: 0.5, goods: 'cheese', qty: 6 },
      { id: 'freezer', x: 3, z: -2, rot: 180, t: 1, goods: 'frozen-pizza', qty: 8 },
      { id: 'open-chiller', x: 3, z: -1, rot: 180, t: 1, goods: 'butter', qty: 10 },
      { id: 'cooler', x: 3, z: 0, rot: 180, t: 1, goods: 'egg', qty: 12 },
      { id: 'checkout', x: 3, z: 3, rot: 90, t: 1 },
      { id: 'checkout', x: 1, z: 3, rot: 90, t: 0.5 },
      { id: 'bakery-case', x: -3, z: 3, rot: 90, t: 1, goods: 'doughnuts', qty: 9 },
      { id: 'potted-fern', x: 5, z: -3, rot: 0, t: 1 },
      { id: 'barrel', x: -5, z: 2, rot: 0, t: 1 },
      { id: 'entrance-mat', x: 5, z: 4, rot: 0, t: 1 },
    ],
    ceiling: [
      { id: 'pendant-lamp', x: -1.5, z: -2 }, { id: 'pendant-lamp', x: -1.5, z: 1 },
      { id: 'pendant-lamp', x: 1.5, z: -2 }, { id: 'pendant-lamp', x: 1.5, z: 1 },
      { id: 'aisle-sign', x: -1.5, z: -3.4 }, { id: 'aisle-sign', x: 1.5, z: -3.4 },
      { id: 'tube-light', x: 3, z: 3 },
    ],
    people: [
      { x: -1.4, z: -1.2, color: '#e2685c', look: { build: 'stout', hair: 'cap', beard: 'full' } },
      { x: 1.5, z: 0.6, color: '#5b8ff9', look: { build: 'slight', hair: 'bob', face: 'glasses' } },
      { x: 2.1, z: 2.6, color: '#f2a03d', look: { build: 'tall', hair: 'bun' } },
      { x: -0.6, z: 2.9, color: '#7cc46a', look: { build: 'kid', hair: 'spikes' } },
    ],
  },

  shopfront: {
    label: 'Shopfront',
    note: 'The outside face. Where a night look lives or dies.',
    ground: 'road',
    walls: { kind: 'facade', w: 15, z: 1, door: 2.6 },
    camera: { zoom: 1.35, yaw: 45, pitch: 32 },
    fixtures: [
      { id: 'awning', x: -2, z: 1, rot: 0, t: 1 },
      { id: 'awning', x: 2, z: 1, rot: 0, t: 1 },
      { id: 'a-frame-sign', x: 4, z: 3, rot: 20, t: 1 },
      { id: 'lamp-post', x: -6, z: 4, rot: 0, t: 1 },
      { id: 'lamp-post', x: 6, z: 4, rot: 0, t: 1 },
      { id: 'bollard-light', x: -2, z: 4.5, rot: 0, t: 1 },
      { id: 'bollard-light', x: 2, z: 4.5, rot: 0, t: 1 },
      { id: 'park-bench', x: -4, z: 3, rot: 0, t: 1 },
      { id: 'bike-rack', x: 5, z: 2, rot: 0, t: 1 },
      { id: 'terracotta-planter', x: -1, z: 2.4, rot: 0, t: 1 },
      { id: 'bay-tree', x: 1, z: 2.4, rot: 0, t: 1 },
      { id: 'parasol', x: -5, z: 1.6, rot: 0, t: 1 },
      { id: 'bistro-set', x: -5, z: 2.6, rot: 0, t: 1 },
      { id: 'window-box', x: 3, z: 1.2, rot: 0, t: 1 },
    ],
    ceiling: [
      { id: 'open-sign', x: 0, z: 1.1, y: 2.1 },
      { id: 'string-lights', x: -3, z: 1.1, y: 2.5 },
      { id: 'string-lights', x: 3, z: 1.1, y: 2.5 },
      { id: 'hanging-basket', x: -1.6, z: 1.1, y: 2.3 },
      { id: 'hanging-basket', x: 1.6, z: 1.1, y: 2.3 },
    ],
    people: [
      { x: -0.8, z: 3.2, color: '#c98ad9', look: { build: 'regular', hair: 'swept' } },
      { x: 1.2, z: 3.6, color: '#5b8ff9', look: { build: 'buff', hair: 'mohawk', face: 'shades' } },
      { x: 3.4, z: 4.2, color: '#e2685c', look: { build: 'kid', hair: 'beanie' } },
    ],
  },

  catalog: {
    label: 'Catalog',
    note: 'Forty pieces on bare floor. What the style does to everything at once.',
    ground: 'floor',
    walls: null,
    camera: { zoom: 0.8, yaw: 45, pitch: 46 },
    grid: [
      'shelf', 'gondola', 'produce-table', 'pallet-rack', 'bakery-case',
      'freezer', 'cooler', 'cold-rack', 'open-chiller', 'deli-counter',
      'hot-counter', 'checkout', 'station', 'plot', 'bin',
      'belt', 'arm', 'sorter', 'lift', 'packer',
      'awning', 'a-frame-sign', 'lamp-post', 'floor-lamp', 'pendant-lamp',
      'potted-fern', 'bay-tree', 'money-tree', 'barrel', 'basket-stack',
      'bistro-set', 'park-bench', 'parasol', 'bike-rack', 'bollard-light',
      'column-plain', 'christmas-tree', 'terracotta-planter', 'hen-house', 'beehive',
    ],
  },

  farm: {
    label: 'Farm',
    note: 'Grass, beds at four growth stages, and the animals.',
    ground: 'grass',
    walls: null,
    camera: { zoom: 1.45, yaw: 45, pitch: 38 },
    fixtures: [
      { id: 'plot', x: -4, z: -2, rot: 0, t: 1, crop: 'carrot-row', grow: 1 },
      { id: 'plot', x: -3, z: -2, rot: 0, t: 1, crop: 'lettuce-bed', grow: 0.66 },
      { id: 'plot', x: -2, z: -2, rot: 0, t: 1, crop: 'kale-patch', grow: 0.33 },
      { id: 'plot', x: -1, z: -2, rot: 0, t: 1, crop: 'pea-row', grow: 0.1 },
      { id: 'plot', x: -4, z: -1, rot: 0, t: 1, crop: 'chilli-row', grow: 1 },
      { id: 'plot', x: -3, z: -1, rot: 0, t: 1, crop: 'flower-bed', grow: 1 },
      { id: 'plot', x: -2, z: -1, rot: 0, t: 1, crop: 'berry-canes', grow: 0.8 },
      { id: 'plot', x: -1, z: -1, rot: 0, t: 1, crop: 'apple-trees', grow: 1 },
      { id: 'hen-house', x: 2, z: -2, rot: 0, t: 1 },
      { id: 'pig-pen', x: 4, z: -2, rot: 0, t: 1 },
      { id: 'cattle-pen', x: 2, z: 1, rot: 0, t: 1 },
      { id: 'beehive', x: 5, z: 1, rot: 0, t: 1 },
      { id: 'dairy-shed', x: 4, z: 3, rot: 0, t: 1 },
      { id: 'lamp-post', x: 0, z: 3, rot: 0, t: 1 },
    ],
    ceiling: [],
    people: [
      { x: -2.5, z: 0.6, color: '#7cc46a', look: { build: 'regular', hair: 'hardhat' } },
      { x: 1.0, z: 0.2, color: '#f2a03d', look: { build: 'stout', hair: 'crop', beard: 'stubble' } },
    ],
  },
};
