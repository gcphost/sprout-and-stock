/**
 * Bake the icons we actually use into `client/icons.js`.
 *
 * A set is thousands of icons and several megabytes; shipping the JSON to the
 * browser to use forty of them would be absurd, and pulling them from a CDN
 * breaks the moment the game is played over a tunnel or offline. So this lifts
 * exactly the ones named below into a plain string map at build time, and the
 * generated file is committed.
 *
 *   npm run icons
 *
 * Phosphor is MIT, Remix Icon is Apache 2.0 — credited in the output header.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * name in the game → `set:icon`.
 *
 * Phosphor for anything that is a thing in the world, Remix Icon for plain
 * interface chrome. Keeping that split means the world never looks like a
 * settings screen and the settings screen never looks like a shop.
 *
 * **Phosphor, and always the `-fill` weight.** The world half of this file used
 * to be game-icons.net, which is a fantasy set — hand-drawn, wildly uneven in
 * weight, and drawn for a dungeon crawler rather than for a strip of tabs. What
 * it cost is only visible in a ROW: `bookshelf` is a fine drawing and `factory`
 * is a fine drawing, and side by side at 15px one is a cloud of thin lines and
 * the other is a solid block, so the tab strip reads as a set of stickers
 * somebody collected rather than as one control. Phosphor is one hand at one
 * weight, which is the whole of what a strip of marks needs.
 *
 * The weight is a rule and not a preference: every glyph here is `-fill`. The
 * set ships six (thin → fill), they are freely mixable, and mixing them is the
 * same bug the old set had — a `-regular` glyph beside a `-fill` one reads as
 * disabled beside enabled, which is a state this interface actually uses.
 */
const WANTED = {
  // rail
  build: 'ph:hammer-fill',
  seeds: 'ph:plant-fill',
  supplier: 'ph:shopping-cart-simple-fill',
  // A rising line for what the shop could become, a bar chart for how it is
  // doing. Deliberately two different pictures of "a number going up": they sit
  // three rows apart on the same rail, and one chart above another chart is a
  // pair you have to read the labels of.
  upgrades: 'ph:trend-up-fill',
  report: 'ph:chart-bar-fill',
  // Everybody who works here is a machine — see the top of CLAUDE.md — and this
  // was the last place the interface still drew one as a person.
  staff: 'ph:robot-fill',
  help: 'ph:question-fill',
  // The milestone ladder, and the medal the modal wears. Two glyphs rather than
  // one: the rail wants a small mark that reads at 15px in a column of other
  // marks, and the award card wants something that fills a 64px gold disc — a
  // trophy shrunk into the rail is a smudge, and a medal blown up to 34px is a
  // ribbon around nothing.
  milestone: 'ph:trophy-fill',
  medal: 'ph:medal-fill',
  // How many people are in reach of the shop, in the corner HUD. A crowd rather
  // than `staff`'s single machine: the number beside it is the town, and one
  // figure next to a roster count of one would be two readouts wearing the same
  // glyph and meaning opposite things.
  town: 'ph:users-three-fill',
  // The Outdoors tab, which wore `town`'s crowd — three people standing for the
  // one tab in the palette that sells nothing but GROUND. It is the `station`
  // factory again: a reuse that was true of the word ("out there, where the town
  // is") and false of everything on the tab, which is turf, tarmac, pavement and
  // somewhere to leave the car. A tree rather than the sun or a hillside because
  // the argument every other tab's glyph makes is "a thing that is actually in
  // there", and a tree is the one of the three you could plausibly stand on it.
  outdoors: 'ph:tree-fill',
  /**
   * The other two surrounds (`shared/surrounds.js`). Countryside borrows
   * `outdoors` above, which is the same tree drawn for the same reason and is
   * a reuse that is true of both jobs rather than of one.
   *
   * A house and a block of flats, and the pair is chosen as a PAIR: what
   * separates a suburb from a city on this list is density, so the two glyphs
   * have to differ in the same way the two backdrops do. `house` against
   * `buildings` reads as one against several at 15px, where `house` against
   * `bank` or `factory` would read as two unrelated buildings and leave the
   * reader working out which one is bigger.
   */
  house: 'ph:house-fill',
  city: 'ph:buildings-fill',
  // The Furniture tab, and the last of `town`'s three jobs — a crowd of people
  // standing for a bench, a bistro set and a bike rack. Same fix, found the same
  // way: one glyph doing three jobs is right for at most one of them.
  furniture: 'ph:armchair-fill',

  // one per role, so a shift roster reads at a glance
  clerk: 'ph:cash-register-fill',
  stocker: 'ph:package-fill',
  // The one role with no obvious mark. A tractor rather than a person with a
  // hoe, which is the same argument `staff` makes: nobody who works here is a
  // person, so the honest picture of farm work is the machine that does it.
  farmhand: 'ph:tractor-fill',
  chef: 'ph:chef-hat-fill',
  // The four that shipped without one, and the failure is quiet rather than
  // loud: `icon(kind, ICONS.staff)` is the soft lookup, so a kind with no glyph
  // falls back to the robot — which is a perfectly good picture of a hire and
  // says nothing about *which* hire. Four tabs wearing it is a strip where only
  // the labels distinguish anything, and the tabs are 15px marks precisely so
  // you do not have to read them.
  //
  // Each is the TOOL rather than the person, which is `farmhand`'s tractor
  // argument: nobody who works here is a person. The broom would be the obvious
  // janitor and it is spent — `empty` wears it, one strip away — and a glyph
  // doing two jobs is exactly what this is fixing.
  janitor: 'ph:spray-bottle-fill',
  guard: 'ph:security-camera-fill',
  runner: 'ph:trolley-fill',
  // The all-rounder, so there is no one machine to draw. Named for the thing it
  // is, which is the only tab on the strip where that is the honest answer.
  'shop-hand': 'ph:hand-fill',

  // fixtures
  shelf: 'ph:books-fill',
  freezer: 'ph:snowflake-fill',
  // The third kind of shelving, and it shipped without one — which is not a
  // missing picture but a dead client: `KIND_TOOLS` is a module-level literal,
  // so `ICONS.warmer` throws at import time and the game never boots at all.
  // A plate with heat coming off it, which is what the fixture is; the fire
  // glyphs are all a hazard rather than a counter you put a chicken on.
  warmer: 'ph:bowl-steam-fill',
  checkout: 'ph:cash-register-fill',
  plot: 'ph:farm-fill',
  // The Appliances tab, and it wore a FACTORY — a chimney and three storeys
  // standing for a toaster on a counter. An oven is a machine you could
  // actually buy in there, which is the argument every other tab's glyph makes.
  station: 'ph:oven-fill',
  crate: 'ph:package-fill',
  floor: 'ph:grid-four-fill',

  // what you can do to a fixture
  //
  // A real pair, drawn by the same hand, which is what retired the mirror this
  // file used to bake (`flip`, gone with it): game-icons had no descending
  // counterpart to its `progression`, so the down arrow had to BE the up one
  // laid backwards or the two would read as different subjects. Phosphor ships
  // both, so the ladder is one drawing in two directions without a transform.
  tierup: 'ph:arrow-fat-lines-up-fill',
  tierdown: 'ph:arrow-fat-lines-down-fill',
  move: 'ph:hand-grabbing-fill',
  rotate: 'ph:arrow-clockwise-fill',
  empty: 'ph:broom-fill',
  remove: 'ph:trash-fill',
  label: 'ph:tag-fill',

  // tab headings — one per group inside a menu that got too long to scroll
  walk: 'ph:person-simple-walk-fill',
  camera: 'ph:video-camera-fill',
  menus: 'ph:list-fill',
  today: 'ph:calendar-dots-fill',
  trouble: 'ph:warning-fill',
  shop: 'ph:storefront-fill',
  fresh: 'ph:carrot-fill',
  // Glass. It is named for the ambient-goods tab it was baked for and every
  // caller left is a window, which is worth knowing before renaming it: the set
  // has no window (`app-window` is a browser), and a jar is the one thing in it
  // that is a pane of something you see through.
  ambient: 'ph:jar-fill',
  // Anything that hangs. Split out of `ambient` on the swap, because a mason jar
  // was standing in for the Lighting tab and for every ceiling prop in the game
  // — a jar hanging off a ceiling is a picture of a jar, and the tab under it
  // says Lighting.
  lamp: 'ph:lamp-pendant-fill',
  cold: 'ph:thermometer-cold-fill',
  fixtures: 'ph:gear-fill',
  // The Decoration tab, which wore `fixtures`' cog — a machine part standing
  // for the one group in the palette that does nothing at all. A potted plant
  // instead: it is a thing you can actually buy in there.
  decor: 'ph:potted-plant-fill',
  // The shop's own shortlist, and the switches. Faders rather than a second
  // gear on purpose: Shape already wears `gear` and the two tabs sit next to
  // each other, so one gear beside another gear is a row you have to read.
  quick: 'ph:sparkle-fill',
  settings: 'ph:faders-fill',

  // interface chrome
  //
  // Still Remix, and the reason it survived the swap is the honest one: it was
  // already the half of this file nobody was complaining about. The argument for
  // the split has lost most of its teeth, though, and that is worth writing down
  // rather than leaving as a rule that sounds stronger than it is. It used to be
  // load-bearing — a hand-drawn horn among the close and search glyphs read as
  // something you could buy — and with the world half now geometric at one
  // weight, both hands agree and the boundary is close to invisible. So the day
  // a chrome glyph is missing from Remix, take it from Phosphor: matching the
  // ROW it sits in beats keeping a set boundary nobody can see.
  search: 'ri:search-line',
  close: 'ri:close-line',
  // The two ends of a strip that has more on it: chrome sitting on top of the
  // row rather than one more thing in it.
  back: 'ri:arrow-left-s-line',
  on: 'ri:arrow-right-s-line',
  // The Lease tab, beside a strip of tabs that are each a *kind* of unit. Those
  // say what you are looking at; this one says what you would be doing, so a
  // plain plus rather than another picture of a robot — `upgrades`' rising
  // chevrons were a ladder, which is what a tier is and hiring is not.
  hire: 'ri:add-line',
  // The two switches on the clock. Chrome even though a door is a thing in the
  // world: these sit in the HUD next to the search and close glyphs, so what
  // they have to match is the pair beside them rather than the shop.
  open: 'ri:door-open-fill',
  shut: 'ri:door-closed-fill',
  pause: 'ri:pause-fill',
  play: 'ri:play-fill',
  // Sound. Two speaker glyphs because the mute row is a switch and the honest
  // test of a switch is that it moved.
  speaker: 'ri:volume-up-fill',
  muted: 'ri:volume-mute-fill',
  // The music row and the credits tab. A note rather than a third speaker: they
  // sit next to the Sound tab, and two speakers side by side is a strip you
  // have to read rather than recognise.
  music: 'ri:music-2-fill',
  // Supporting the game, which is this file's own rule pointed the right way:
  // the split is "a thing in the world" against "interface chrome", and this is
  // the one control in the game that is not about the shop at all. It wore a
  // coffee mug for a day and the mug was the whole problem — it is the donation
  // *platform's* branding, it
  // said nothing about what the money is for, and a drink is not a thing this
  // shop sells. A heart says "back this" in every interface anybody has used.
  support: 'ri:heart-3-fill',
  /**
   * The emote strip (`shared/emotes.js`).
   *
   * Phosphor rather than Remix, which is this file's split applied to a row
   * that looks like chrome and is not: these four are the only buttons in the
   * interface whose subject is your own body standing in the shop. A press
   * here moves something out there.
   *
   * Three of the four are HANDS and the fourth is a pair of notes, and that is
   * as close to a set as the icon library gets: there is no "person dancing"
   * at fill weight, and the alternatives (`person-simple-tai-chi`, which reads
   * as yoga, and `person-arms-spread`, which is the cheer again) are worse
   * than changing the subject. Notes say what the pose is FOR, which is the
   * job of a 15px mark.
   */
  wave: 'ph:hand-waving-fill',
  cheer: 'ph:confetti-fill',
  dance: 'ph:music-notes-fill',
  point: 'ph:hand-pointing-fill',
  /**
   * WHICH WAY GOODS CROSS ONE SIDE OF A MACHINE — see `handsAcross`.
   *
   * Four states of one thing, so they are chosen as a set and the set has one
   * rule: the ARROW is the state and everything else is furniture. A door and a
   * gate would each be a picture of a different noun at 15px, where two signs
   * pointing opposite ways are the same sign said twice, which is what makes
   * `in` and `out` readable side by side on tiles an inch apart.
   *
   * `off` is the odd one and has to be: it is the absence of an arrow rather
   * than a fifth direction, and a barred circle is the one glyph in the library
   * that says "not this one" without pointing anywhere.
   */
  wayBoth: 'ph:arrows-left-right-fill',
  wayIn: 'ph:sign-in-fill',
  wayOut: 'ph:sign-out-fill',
  wayOff: 'ph:prohibit-fill',
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

// A name is `set:icon` and nothing else. It used to be that or a `{ref, flip}`
// pair, baking one glyph twice for a ladder whose set had only the up arrow —
// see `tierup` for why a set that draws both retires the transform rather than
// keeping it about in case. A mirror is one line to put back if anything ever
// needs one, and dead machinery with a rationale attached reads as a rule.
for (const [key, ref] of Object.entries(WANTED)) {
  const [setName, iconName] = ref.split(':');
  const set = load(setName);
  const icon = set.icons[iconName];
  if (!icon) { missing.push(ref); continue; }
  const w = icon.width ?? set.width ?? 24;
  const h = icon.height ?? set.height ?? 24;
  // width/height in em so every existing font-size rule keeps sizing them, and
  // currentColor so they inherit whatever the button is already coloured.
  out[key] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" `
    + `width="1em" height="1em" fill="currentColor" aria-hidden="true">${icon.body}</svg>`;
}

if (missing.length) {
  console.error(`[icons] no such icon: ${missing.join(', ')}`);
  process.exit(1);
}

// A key is quoted unless it is a bare identifier. Names here are game names and
// most of them are one word, which is why this went four rounds without one —
// but a worker kind is a content id, and `shop-hand` written unquoted is not an
// ugly key, it is a syntax error in the generated file. Which is the whole
// client: the first thing that imports `icons.js` fails and the game never
// boots, from a build step whose own output is the thing that is wrong.
const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`);

const body = Object.entries(out)
  .map(([k, v]) => `  ${key(k)}: '${v.replace(/'/g, "\\'")}',`)
  .join('\n');

writeFileSync(join(root, 'client', 'icons.js'), `/**
 * GENERATED by \`npm run icons\` — do not edit.
 *
 * Add a name to WANTED in scripts/build-icons.js and re-run instead.
 *
 * Icons from Phosphor (MIT) and Remix Icon (Apache 2.0).
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
