/**
 * The thirty hues everybody in the shop is painted out of.
 *
 * A body's colour used to be authored one row at a time — twenty archetypes,
 * eight worker kinds and a four-colour player cycle, each picked by whoever was
 * writing that row, none of them looking at the others. Which is why the crowd
 * came out as forty variations of the same muted mid-tone: nothing was WRONG
 * anywhere, and there was no place to stand where you could see they all
 * disagreed. A palette is that place.
 *
 * It lives in `shared/` for the reason `build.js` and `jobs.js` do — both ends
 * ask. The server hands a joining player their colour, and the client is where
 * a colour is a picture; a table with two spellings is a table that drifts, and
 * the last one had exactly that (`PLAYER_COLORS` in `client/render/palette.js`
 * beside a literal array in `Game.addPlayer`, which is the one the game
 * actually used).
 *
 * ## What a hue has to survive
 *
 * A body is not a swatch. `characterParts` derives the whole outfit from this
 * one number — trousers at `shade(-0.34)`, shoes at `shade(-0.62)` — so a hue
 * chosen for how it looks as a circle is a hue that has to still read three
 * steps down. That is the whole of what makes the darkest entries here
 * different from the rest, rather than merely darker: `soot` bottoms out at
 * black for its shoes and `midnight` is not far behind, so those two are the
 * COAT of a character whose coat is the point (the emo, the office worker)
 * rather than colours anything should be handed at random.
 *
 * Which is also why nothing here is generated. A ramp would give thirty evenly
 * spaced hues and a crowd that reads as a colour wheel; these are a picked set,
 * with the greens and purples deliberately over-represented because that is
 * what a shop full of people wearing coats looks like.
 *
 * ## Who gets what
 *
 * `PLAYER_COLORS` is the only band that is exclusive, and it has to be: finding
 * yourself in your own shop is the one thing a colour is load-bearing for.
 * Everything else is a suggestion — an archetype and a worker kind each store
 * their own hex on their content row, because content is edited live and a row
 * that could only name a palette entry would be a row you cannot author a
 * one-off for. What this table buys them is a place to be chosen FROM.
 *
 * The convention the shipped rows follow, and worth keeping when you author the
 * next one: **the deep and muted end is the crew, the bright end is the
 * crowd.** A hire is three-quarters of a shopper's height and stands at a post,
 * so the two never have to be told apart by hue alone — which is what lets the
 * two duplicated entries below (`clay`, `brick`) be shared across the line
 * rather than within it.
 */

/** Named so a content row can be argued about in words rather than in hex. */
export const PEOPLE = {
  // --- greens ---
  grass: '#55b04f',
  lime: '#9ad45c',
  neon: '#4de04d',
  fern: '#7fcc6b',
  mint: '#93f0bd',
  olive: '#a89b25',
  pine: '#2e4b4b',
  // --- blues ---
  cornflower: '#6199ef',
  sky: '#7cbdf0',
  steel: '#1f5279',
  slate: '#8ba0bd',
  midnight: '#1d1f4e',
  // --- yellows ---
  amber: '#eeb43c',
  lemon: '#f0dc42',
  gold: '#f0d030',
  sand: '#e5cf95',
  // --- reds and pinks ---
  rose: '#d97070',
  fuchsia: '#e8557f',
  blush: '#e8b0c4',
  brick: '#8a2f20',
  rust: '#8f2408',
  // --- purples ---
  lavender: '#9377e0',
  violet: '#8f6cc0',
  plum: '#653166',
  grape: '#5c2f66',
  aubergine: '#432f56',
  // --- warm neutrals ---
  peach: '#e8bb99',
  clay: '#8f5c50',
  // --- neutrals ---
  ash: '#8c8c8c',
  soot: '#111111',
};

/**
 * The four a human joining is cycled through, by join order.
 *
 * One per hue quadrant and all four at the bright end, because this is the one
 * band that is read at a glance across a shop with eighty other people in it.
 * Nothing else in the game may use them — see the header.
 */
export const PLAYER_COLORS = [
  PEOPLE.cornflower,
  PEOPLE.amber,
  PEOPLE.neon,
  PEOPLE.fuchsia,
];

/**
 * The two that bottom out at black three shades down.
 *
 * Not a ban — the emo and the office worker are both better for being allowed
 * one — but a hue nothing should be handed by a generator, and the first thing
 * to check when a new body reads as a hole in the floor.
 */
export const DARKEST = [PEOPLE.soot, PEOPLE.midnight];
