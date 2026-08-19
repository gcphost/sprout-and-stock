/**
 * Bake the icons we actually use into `client/icons.js`.
 *
 * The full game-icons set is 4134 icons and several megabytes; shipping the
 * JSON to the browser to use twenty of them would be absurd, and pulling them
 * from a CDN breaks the moment the game is played over a tunnel or offline.
 * So this lifts exactly the ones named below into a plain string map at build
 * time, and the generated file is committed.
 *
 *   npm run icons
 *
 * game-icons.net is CC BY 3.0 — see ATTRIBUTION at the bottom of the output.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * name in the game → `set:icon`.
 *
 * game-icons for anything that is a thing in the world, remix-icon for plain
 * interface chrome. Keeping that split means the world never looks like a
 * settings screen and the settings screen never looks like a dungeon crawler.
 */
const WANTED = {
  // rail
  build: 'game-icons:claw-hammer',
  seeds: 'game-icons:plant-seed',
  supplier: 'game-icons:shopping-cart',
  upgrades: 'game-icons:upgrade',
  report: 'game-icons:chart',
  // Everybody who works here is a machine — see the top of CLAUDE.md — and this
  // was the last place the interface still drew one as a person. A full standing
  // figure rather than one of the set's robot HEADS, because it stands in for
  // `person` in a column of marks read at 15px: a silhouette says "somebody" at
  // that size and a face says "a smudge".
  staff: 'game-icons:vintage-robot',
  help: 'game-icons:help',
  // The milestone ladder, and the medal the modal wears. Two glyphs rather than
  // one: the rail wants a small mark that reads at 15px in a column of other
  // marks, and the award card wants something that fills a 64px gold disc — a
  // trophy shrunk into the rail is a smudge, and a laurel blown up to 34px is a
  // wreath around nothing.
  milestone: 'game-icons:trophy',
  medal: 'game-icons:laurel-crown',
  // How many people are in reach of the shop, in the corner HUD. A crowd rather
  // than `staff`'s single person: the number beside it is the town, and one
  // figure next to a roster count of one would be two readouts wearing the same
  // glyph and meaning opposite things.
  town: 'game-icons:three-friends',

  // one per role, so a shift roster reads at a glance
  clerk: 'game-icons:cash',
  stocker: 'game-icons:cardboard-box',
  farmhand: 'game-icons:farmer',
  chef: 'game-icons:chef-toque',

  // fixtures
  shelf: 'game-icons:bookshelf',
  freezer: 'game-icons:fridge',
  // The third kind of shelving, and it shipped without one — which is not a
  // missing picture but a dead client: `KIND_TOOLS` is a module-level literal,
  // so `ICONS.warmer` throws at import time and the game never boots at all.
  // A plate under a heat lamp, which is what the fixture is; the fire glyphs
  // are all a hazard rather than a counter you put a chicken on.
  warmer: 'game-icons:hot-meal',
  checkout: 'game-icons:cash',
  plot: 'game-icons:field',
  station: 'game-icons:factory',
  crate: 'game-icons:cardboard-box',
  floor: 'game-icons:stone-path',

  // what you can do to a fixture
  tierup: 'game-icons:progression',
  // The same glyph, mirrored — see `flip` below. The set has no descending
  // counterpart to `progression`, and the near misses (`armor-downgrade`,
  // `team-downgrade`) are pictures of something else with an arrow on them:
  // beside a rising chart they would read as two different subjects rather than
  // as one ladder with two directions.
  tierdown: { ref: 'game-icons:progression', flip: 'x' },
  move: 'game-icons:grab',
  rotate: 'game-icons:clockwise-rotation',
  empty: 'game-icons:broom',
  remove: 'game-icons:trash-can',
  label: 'game-icons:price-tag',

  // tab headings — one per group inside a menu that got too long to scroll
  walk: 'game-icons:walk',
  camera: 'game-icons:video-camera',
  menus: 'game-icons:hamburger-menu',
  today: 'game-icons:calendar',
  trouble: 'game-icons:hazard-sign',
  shop: 'game-icons:shop',
  fresh: 'game-icons:fruit-bowl',
  ambient: 'game-icons:mason-jar',
  cold: 'game-icons:snowflake-2',
  fixtures: 'game-icons:cog',
  // The Decoration tab, which wore `fixtures`' cog — a machine part standing
  // for the one group in the palette that does nothing at all. A potted plant
  // instead: it is a thing you can actually buy in there, which is the same
  // argument every other tab's glyph makes.
  decor: 'game-icons:flower-pot',
  // The shop's own shortlist, and the switches. `settings-knobs` rather than a
  // second cog on purpose: Shape already wears `cog` and the two tabs sit next
  // to each other, so one gear beside another gear is a row you have to read.
  quick: 'game-icons:sparkles',
  settings: 'game-icons:settings-knobs',

  // interface chrome
  search: 'ri:search-line',
  close: 'ri:close-line',
  // The two ends of a strip that has more on it. Remix rather than game-icons
  // for the reason the doors are: these are chrome sitting on top of the row,
  // and a hand-drawn arrow among a line of shelves would read as a fixture.
  back: 'ri:arrow-left-s-line',
  on: 'ri:arrow-right-s-line',
  // The Lease tab, beside a strip of tabs that are each a *kind* of unit. Those
  // say what you are looking at; this one says what you would be doing, so a
  // plain plus rather than another picture of a robot — `upgrades`' rising
  // chevrons were a ladder, which is what a tier is and hiring is not.
  hire: 'ri:add-line',
  // The two switches on the clock. Remix rather than game-icons even though a
  // door is a thing in the world: these sit in the HUD next to the search and
  // close glyphs, and one hand-drawn dungeon door among them would read as a
  // fixture you can buy rather than as a button.
  open: 'ri:door-open-fill',
  shut: 'ri:door-closed-fill',
  pause: 'ri:pause-fill',
  play: 'ri:play-fill',
  // Sound. Remix rather than game-icons for the same reason the doors are:
  // these are settings rows, and a hand-drawn horn among the close and search
  // glyphs would read as something you can buy. Two speaker glyphs because the
  // mute row is a switch and the honest test of a switch is that it moved.
  speaker: 'ri:volume-up-fill',
  muted: 'ri:volume-mute-fill',
  // The music row and the credits tab. A note rather than a third speaker: they
  // sit next to the Sound tab, and two speakers side by side is a strip you
  // have to read rather than recognise.
  music: 'ri:music-2-fill',
  // Supporting the game. Remix rather than game-icons, which is this file's own
  // rule pointed the right way: the split is "a thing in the world" against
  // "interface chrome", and this is the one control in the game that is not
  // about the shop at all. It wore `game-icons:coffee-mug` for a day and the
  // mug was the whole problem — it is the donation *platform's* branding, it
  // said nothing about what the money is for, and a drink is not a thing this
  // shop sells. A heart says "back this" in every interface anybody has used.
  support: 'ri:heart-3-fill',
};

const sets = {};
const load = (set) => {
  if (!sets[set]) {
    sets[set] = JSON.parse(readFileSync(join(root, 'node_modules', `@iconify-json/${set}`, 'icons.json'), 'utf8'));
  }
  return sets[set];
};

const missing = [];
const out = {};

for (const [key, want] of Object.entries(WANTED)) {
  // A name is either `set:icon` or that plus a mirror. Deriving the second
  // glyph from the first is the same argument `client/thumb.js` makes about
  // drawing a fixture from its own row: a pair that must read as one action in
  // two directions has to *be* one drawing, or the day somebody swaps the up
  // arrow the down one quietly stops matching it.
  const { ref, flip = null } = typeof want === 'string' ? { ref: want } : want;
  const [setName, iconName] = ref.split(':');
  const set = load(setName);
  const icon = set.icons[iconName];
  if (!icon) { missing.push(ref); continue; }
  const w = icon.width ?? set.width ?? 24;
  const h = icon.height ?? set.height ?? 24;
  // Mirrored about the middle, so it lands back inside the same viewBox.
  // Horizontally by default and by design: these are drawn standing on a
  // baseline, and flipping one top-to-bottom hangs it from the ceiling.
  const body = flip
    ? `<g transform="${flip === 'y' ? `translate(0,${h}) scale(1,-1)` : `translate(${w},0) scale(-1,1)`}">${icon.body}</g>`
    : icon.body;
  // width/height in em so every existing font-size rule keeps sizing them, and
  // currentColor so they inherit whatever the button is already coloured.
  out[key] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" `
    + `width="1em" height="1em" fill="currentColor" aria-hidden="true">${body}</svg>`;
}

if (missing.length) {
  console.error(`[icons] no such icon: ${missing.join(', ')}`);
  process.exit(1);
}

const body = Object.entries(out)
  .map(([k, v]) => `  ${k}: '${v.replace(/'/g, "\\'")}',`)
  .join('\n');

writeFileSync(join(root, 'client', 'icons.js'), `/**
 * GENERATED by \`npm run icons\` — do not edit.
 *
 * Add a name to WANTED in scripts/build-icons.js and re-run instead.
 *
 * Icons from game-icons.net (CC BY 3.0) and Remix Icon (Apache 2.0).
 */

const SET = {
${body}
};

/**
 * Asking for an icon that was never baked in used to interpolate the string
 * "undefined" into the markup and sit there looking like a rendering bug. It is
 * a missing build step, so it says so, at the first render rather than never.
 */
/**
 * For names that legitimately may not exist — an icon per authored worker kind,
 * say, where the kinds come from the database and the icons do not.
 *
 * \`ICONS[x] ?? fallback\` cannot do this: the strict lookup below throws before
 * \`??\` ever sees a value. Asking whether an icon exists is a different question
 * from asking for one, so it gets a different call.
 */
export const icon = (name, fallback = null) => (name in SET ? SET[name] : fallback);

export const ICONS = new Proxy(SET, {
  get(all, name) {
    if (typeof name !== 'string' || name in all) return all[name];
    // Bundlers and \`await import()\` probe objects for these.
    if (name === 'then' || name === '__esModule') return undefined;
    throw new Error(\`[icons] no icon "\${name}" — add it to WANTED in scripts/build-icons.js and run npm run icons\`);
  },
});
`);

console.log(`[icons] wrote client/icons.js — ${Object.keys(out).length} icons`);
