/**
 * SAVE SLOTS — what a world is, who is in one, and which one you meant.
 *
 * Everything above this file talks about "the game". Everything below it talks
 * about rows. This is the layer in between: it names worlds, mints their first
 * save, and hands out the live room for one.
 *
 * A save is kept until somebody deletes it, and that is the whole policy. There
 * used to be a sweeper that binned worlds nobody had opened for a fortnight,
 * which is why the menu carried a Keep button: a shop could go away on its own,
 * so you needed a way to say "not this one". Nothing expires now, so there is
 * nothing to protect a world from, and both halves are gone.
 *
 * The one rule worth stating out loud, because the rest of the codebase leans
 * on it: **content is not part of a world.** Items, crops, customers, fixtures,
 * workers and recipes are one shared library that every save reads from. That
 * is the whole co-op premise — a tomato added over MCP has to show up in your
 * shop and in the one next door — and it is why `deleteWorld` never touches a
 * content table.
 */

import {
  DEFAULT_WORLD_ID, listWorldRows, worldRow, insertWorldRow, deleteWorldRow,
  touchWorldRow, renameWorldRow, getWorld, setWorld,
} from './db.js';
import { world as loadWorld, saveWorld, DEFAULT_WORLD, content } from './content.js';
// From `shop.js` and not `MartRoom.js`: what this module wants is the live-room
// registry, and reaching it through the Colyseus binding would pull a websocket
// server into every build that imports this file — including a browser one,
// which is where `createWorld` is now also called from. See docs/browser.md.
import { rooms, primaryRoom } from './rooms/shop.js';
import { startTier, tierFixtures, tierById, START_TIERS, DEFAULT_TIER } from '../shared/start.js';
import { cleanName, SHOP_NAME_MAX } from '../shared/names.js';
import { startDifficulty, difficultyOf } from '../shared/difficulty.js';
import { surroundOf } from '../shared/surrounds.js';
import { PREP_HOUR } from './sim/index.js';
import { STORE_NORTH_LEGACY } from './layout.js';

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * A readable id, because an agent has to type these into `use_world` and
 * `w1f3k2p` tells nobody anything. Collisions get a numeric tail rather than a
 * rejection — two shops called "Corner Shop" is a thing a family does.
 */
function mintId(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)
    || 'shop';
  if (!worldRow(base)) return base;
  for (let n = 2; n < 500; n++) {
    if (!worldRow(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

const randomSeed = () => Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every live room playing a given world. Usually one; more only mid-restart. */
export function roomsFor(worldId) {
  return [...rooms].filter((r) => r.worldId === worldId);
}

/**
 * WHICH SIZE OF SHOP THIS IS, for the chip on the menu row.
 *
 * Written onto the save at creation (see `startingState`), so this is a read
 * with a fallback rather than a guess — but every shop that predates the field
 * has to answer something, because the three chips are the only thing that
 * tells one save from another before you open it. Every one of them is called
 * `Shop N`.
 *
 * The fallback counts the shelving the shop is standing in against the counts
 * the tiers themselves are authored with, so it is the same table making both
 * answers rather than three thresholds somebody picked. It says something
 * slightly different from the stored field — how big the shop IS rather than
 * how big it started — and that is the honest answer for a save that never
 * recorded the second one.
 */
const SHELVING = new Set(['shelf', 'freezer', 'warmer']);
const tierUnits = (t) => [...SHELVING].reduce((n, k) => n + (t.fixtures[k] ?? 0), 0);

function sizeOf(w) {
  if (tierById(w.tier)) return w.tier;
  const units = (w.placements ?? []).filter((p) => SHELVING.has(p.kind)).length;
  const ladder = [...START_TIERS].sort((a, b) => tierUnits(b) - tierUnits(a));
  return (ladder.find((t) => units >= tierUnits(t)) ?? tierById(DEFAULT_TIER)).id;
}

/**
 * THE SAVE'S OWN FLOOR PLAN, as a grid of characters.
 *
 * The front door draws a top-down square per shop (see `client/frontart.js`),
 * and the whole reason it is worth the field is that it comes from the SAVE:
 * a picture derived from the tier would be a picture of a *type* of shop, and
 * two shops played differently would come out identical — which is precisely
 * the job the square is doing, since every one of them is called `Shop N`.
 *
 * A GRID AND NOT A RECT, and that is the one thing here worth arguing about.
 * The obvious payload is `shell` plus the fixture tiles — the building is a
 * rectangle, so send the rectangle — and it is wrong about every shop anybody
 * has actually played in. `shell` is what the GENERATOR stamped and nothing
 * else: from the moment somebody draws a wall of their own, the building is
 * `edits` and the floor they painted inside it, and the stamp stays whatever it
 * was on day one. A live save on day 514 has a 7x8 shell with shelving standing
 * from x5 to x26, so the rect version of this drew a small box with two thirds
 * of the shop scattered outside it — which reads as the plan being broken
 * rather than as the shop having been extended.
 *
 * So the cells are the picture: floor (the shell's own stamp plus every cell of
 * floor anybody has painted), the pads, and what is standing on them. Which
 * also hands the client its outline for free — an edge is where an inside cell
 * meets an outside one — and outlining an arbitrary room is the one thing a
 * rect could do that a set of cells cannot obviously do.
 *
 * Three things keep it cheap. It is opt-in per request (`plan: true`, which
 * only the menu asks for) because this is a LIST endpoint and `list_worlds`
 * hands its whole answer to an agent's context. It carries a bare grid of
 * characters and no geometry — no colours, no sizes, no rotation — so what a
 * plan LOOKS like stays a client decision. And it is capped: past `PLAN_MAX`
 * cells across it is sampled down rather than cropped, because a picture that
 * loses the farm off one edge is worse than one drawn two tiles to a pixel.
 *
 * The one thing it deliberately does NOT read is the walls. `edits` is a list
 * of lattice segments and what an outline wants is the enclosure they make,
 * which is `computeIndoor` — a whole layout, generated, per save, on the list
 * endpoint. Painted floor is the same answer for a tenth of the work: you
 * cannot put a shelf on a cell you have not floored, so a room worth drawing is
 * a room with a floor in it.
 *
 * A shop nobody has opened yet has no shell, no floor and no placements, and
 * the honest answer there is null: there is nothing built to draw. The client
 * draws an empty lot for it, and the real plan turns up the moment somebody
 * walks in.
 */
const PLAN_KINDS = {
  shelf: 's', freezer: 's', warmer: 's',   // shelving
  checkout: 't',                           // the till
  plot: 'b',                               // a growing rack
  station: 'm', pen: 'm', packer: 'm',     // machines
};
/**
 * The five pads, all one character.
 *
 * They are five different jobs and they are one thing from four metres up: the
 * shop's own working ground, as opposed to the floor you walk a trolley on. A
 * character each would be four more colours in a 64px square for a distinction
 * nobody is reading it to make.
 */
const PLAN_PADS = new Set(['bay', 'drop', 'break', 'park', 'paddock']);
/** The look that is the shop rather than the street. Road, path and lawn are not. */
const PLAN_FLOOR = 'floor';
/** How many cells across the grid may get before it is sampled down. */
const PLAN_MAX = 44;
/** Which character wins when several land in one sampled cell. */
const PLAN_RANK = { '.': 0, y: 1, f: 2, m: 3, b: 4, t: 5, s: 6 };

function planOf(w) {
  const cells = new Map();
  const put = (x, z, ch) => {
    const key = `${x},${z}`;
    const was = cells.get(key);
    if (was === undefined || PLAN_RANK[ch] > PLAN_RANK[was]) cells.set(key, ch);
  };

  /**
   * The generated stamp, which is the whole floor of a shop nobody has built in
   * and the middle of one they have.
   *
   * `shell.x` was added long after `shell.w`, so a shop frozen before that day
   * knows how big it is and not where it is. Derived from what is standing
   * indoors, which is the one thing on those saves that does know — and a
   * building drawn two tiles off its own shelving is the failure this avoids,
   * not a missing picture.
   */
  const placements = w.placements ?? [];
  const shell = w.shell ?? null;
  if (shell) {
    const inside = placements.filter((p) => 'st'.includes(PLAN_KINDS[p.kind] ?? ''));
    const west = shell.x ?? (inside.length
      ? Math.max(0, Math.min(...inside.map((p) => p.x)) - 1)
      : 0);
    const north = shell.z ?? STORE_NORTH_LEGACY;
    for (let dx = 0; dx < shell.w; dx++) {
      for (let dz = 0; dz < shell.h; dz++) put(west + dx, north + dz, 'f');
    }
  }

  // ...and every cell of ground anybody has painted since. `u` is the look a
  // pad was laid OVER (see `groundPaint` in shared/build.js) — a stockroom on
  // shop floor is still shop floor underneath, and reading only the top layer
  // would punch a hole in the building wherever somebody painted one.
  for (const g of w.ground ?? []) {
    if (PLAN_PADS.has(g.k)) put(g.x, g.z, 'y');
    else if (g.k === PLAN_FLOOR) put(g.x, g.z, 'f');
    else if (g.u?.k === PLAN_FLOOR) put(g.x, g.z, 'f');
  }

  for (const p of placements) {
    const ch = PLAN_KINDS[p.kind];
    if (ch) put(p.x, p.z, ch);
  }

  if (!cells.size) return null;

  let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
  for (const key of cells.keys()) {
    const [x, z] = key.split(',').map(Number);
    if (x < x0) x0 = x;
    if (z < z0) z0 = z;
    if (x > x1) x1 = x;
    if (z > z1) z1 = z;
  }

  // Sampled rather than cropped past the cap, for the reason in the header: a
  // shop that has grown to forty tiles across is exactly the shop whose SHAPE
  // is the interesting thing about it, and cropping it would take the farm off.
  const step = Math.max(1, Math.ceil(Math.max(x1 - x0 + 1, z1 - z0 + 1) / PLAN_MAX));
  const gw = Math.ceil((x1 - x0 + 1) / step);
  const gh = Math.ceil((z1 - z0 + 1) / step);
  const grid = new Array(gw * gh).fill('.');
  for (const [key, ch] of cells) {
    const [x, z] = key.split(',').map(Number);
    const at = Math.floor((z - z0) / step) * gw + Math.floor((x - x0) / step);
    if (PLAN_RANK[ch] > PLAN_RANK[grid[at]]) grid[at] = ch;
  }

  return { w: gw, h: gh, g: grid.join('') };
}

/**
 * What the menu shows for one save.
 *
 * Read off the live room when there is one, and off the save blob otherwise.
 * That order matters: a room holds an hour of play that `persist()` has written
 * but `played_at` has not moved for, so asking the row would show a shop that
 * is being played right now as sitting at whatever it was when it opened.
 */
export function summarise(row, { plan = false } = {}) {
  const live = roomsFor(row.id);
  const g = live[0]?.game;
  const w = g ?? loadWorld(row.id);
  return {
    id: row.id,
    name: row.name,
    seed: row.seed,
    created_at: row.created_at,
    played_at: row.played_at,
    live: live.length > 0,
    players: live.reduce((n, r) => n + r.clients.length, 0),
    day: w.day ?? DEFAULT_WORLD.day,
    cash: Math.round((w.cash ?? DEFAULT_WORLD.cash) * 100) / 100,
    season: w.season ?? DEFAULT_WORLD.season,
    // Resolved rather than raw, so a save that predates the field answers
    // `relaxed` — the preset it is actually being played on — instead of null.
    // Nothing in the menu can then draw a shop as having no difficulty, which
    // is not a state any shop is in.
    difficulty: difficultyOf(w.difficulty).id,
    // The other two thirds of what tells one `Shop N` from another on the front
    // door. Both are resolved rather than raw, for `difficulty`'s reason: a
    // save that predates either field is being *played* on an answer, so the
    // menu should never have to draw a shop as having no setting.
    tier: sizeOf(w),
    surround: surroundOf(w.surround),
    reputation: w.reputation ?? DEFAULT_WORLD.reputation,
    upgrades: (w.ownedUpgrades ?? []).length,
    staff: (w.roster ?? []).length,
    ...(plan ? { plan: planOf(w) } : {}),
  };
}

export function listWorlds(opts) {
  return listWorldRows().map((row) => summarise(row, opts));
}

export function getWorldSummary(id) {
  const row = worldRow(id);
  return row ? summarise(row) : null;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * What a new shop may be started with, and how silly an ask may get.
 *
 * All of it is *starting* state, and the counts can only ever be set here. Cash
 * is spent from the first minute; the counts are read exactly once, by
 * `starterShop`, before `freezeShell` stamps the building and the shop becomes
 * its placements. After that the shop is what is standing in it, and asking for
 * "twelve shelves" has nowhere to land.
 *
 * The counts are a **tier** now (`shared/start.js`) rather than three numbers
 * somebody types, and `shelves`/`plots` survive as an override on top of one —
 * they are how a balance run asks for a shop no tier describes, and they are
 * not in the menu any more, because a shelf count chosen before you have seen a
 * shelf is a decision with nothing behind it.
 *
 * The ceilings are what `verify:layout` actually sweeps — 25 shelves, 32 plots —
 * rather than a guess at what the generator will take. Past the sweep the
 * failure is a shop nobody can walk through, which is invisible from the menu
 * that asked for it.
 *
 * Season is deliberately not here. `onNewDay` derives it from the day, so a
 * shop started in winter is spring again by the next morning: a field that
 * unpicks itself inside one in-game day is worse than no field at all.
 */
const START_LIMITS = {
  cash: { min: 0, max: 1e6, cents: true },
  shelves: { min: 1, max: 25 },
  plots: { min: 1, max: 32 },
};

/**
 * One asked-for number, or `undefined` for "you didn't say".
 *
 * Blank has to mean the default rather than zero, because every one of these
 * arrives from a text box somebody left alone. Out of range is clamped rather
 * than refused: bouncing a whole new shop over a typo'd shelf count is a worse
 * trade than quietly giving you 25. The menu used to print all three ranges to
 * say so, which is a paragraph spent on a rule that only fires for numbers
 * nobody types — the boxes carry `min`/`max` and this clamps whatever arrives.
 */
function startingNumber(v, { min, max, cents = false }) {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const clamped = Math.min(max, Math.max(min, n));
  return cents ? Math.round(clamped * 100) / 100 : Math.round(clamped);
}

/**
 * The save patch a new shop starts from: money, and the shop around it.
 *
 * The tier is always written, even when nobody chose one, and that is the one
 * decision in here worth stating. It could default at read time instead —
 * `starterShop` merges over `BASE_FIXTURES`, so a save with no `fixtures` at all
 * furnishes perfectly well — but then what a shop opened with would depend on
 * which build was running the day somebody walked into it, and a save minted in
 * the menu and opened next week would be a different shop from the one the
 * buttons described. Writing it at creation is what makes the choice a *fact
 * about that save*.
 */
function startingState({ cash, tier, difficulty, surround, shelves, plots }) {
  const state = { cash: cash ?? startTier(tier).cash };

  /**
   * ...and how hard the town is, which is written for the same reason the tier
   * is and defaults the OTHER WAY from how it is read.
   *
   * `startDifficulty` falls back to `normal`; `difficultyOf`, which every load
   * goes through, falls back to `relaxed`. That is not an inconsistency, it is
   * the whole safety of the feature: `relaxed` carries the constants the game
   * shipped with, so every save that predates this field and every headless
   * game — `simulate`, all fifteen `verify:*` sweeps — reads exactly the numbers
   * it always did, while a shop somebody starts today gets a game with a bottom
   * to it. See `shared/difficulty.js`.
   */
  state.difficulty = startDifficulty(difficulty).id;

  /**
   * ...and what is out of the windows, which is written here for the tier's
   * reason and narrows the way every other read of this field does.
   *
   * `surroundOf` answers `country` for anything it does not recognise, which is
   * what a save that predates the field reads as — so an older client that has
   * never heard of the form's third row still mints exactly the shop it always
   * did. Both defaults being the same is the difference between this and
   * `difficulty` above, and it is the safe direction: this one is a picture,
   * so there is no version of it that quietly plays differently.
   */
  state.surround = surroundOf(surround);

  /**
   * ...and WHICH SIZE was asked for, which is the one of the three that is not
   * read by anything in the sim.
   *
   * It is written for the menu, and only the menu: `fixtures` below is what the
   * shop is actually furnished from, and the moment `freezeShell` runs that
   * budget stops being true — the shop is what is standing in it. So the field
   * says which of three shops somebody *chose*, which is a fact about the save
   * nothing else could answer afterwards, and which is a third of what tells
   * one `Shop N` apart from the next on the front door.
   *
   * Every save that predates it derives one instead — see `sizeOf`, which is
   * why this is not a migration.
   */
  state.tier = startTier(tier).id;

  // `fixtures` here is the one-shot budget `starterShop` reads to furnish a shop
  // nobody has opened yet, not the stored ledger step 9 retired: it is merged
  // over the base shop, so a tier naming only `shelf` would still get you your
  // till, and the first `persist()` overwrites it with the ledger derived from
  // what actually got placed.
  state.fixtures = tierFixtures(tier);
  if (shelves !== undefined) state.fixtures.shelf = shelves;
  if (plots !== undefined) state.fixtures.plot = plots;

  // The compat mirror `persist()` writes for older builds — set here too, or a
  // save reads one way for one day and the other way forever after.
  state.shelves = state.fixtures.shelf;
  state.plots = state.fixtures.plot;
  const hand = starterHire();
  state.roster = hand ? [hand] : [];
  state.nextWorkerId = state.roster.length + 1;

  const order = starterOrder();
  if (order) state.orders = { ...(DEFAULT_WORLD.orders ?? {}), pending: [order] };
  return state;
}

/**
 * SOMEBODY IS ALREADY HERE.
 *
 * A new shop opened bare: a building, two shelves, a till, and nobody in it. So
 * the first several minutes of the game were a still frame — nothing moved
 * until the player made it move, and the one thing a shop is *for* (a machine
 * putting stock out while you decide where the freezer goes) was four minutes
 * and about $200 away. What that reads as is a game that has not started, which
 * is the shape every piece of onboarding advice warns about and the one thing a
 * screenshot cannot show you, because an empty shop and a broken shop are the
 * same picture.
 *
 * A **Shop Hand** and not a Clerk, for the reason the tour picks one: a hand
 * serves, unloads, shelves, farms and tidies, so one of them is the shop
 * ticking over rather than one counter manned. A clerk in an empty shop has
 * nothing to do at all.
 *
 * Three things about the row are worth knowing.
 *
 * It is written **onto the save** rather than hired on first open, so the wage
 * is honest from day one and the menu can count them before anybody has gone
 * in — the same reason the blank save is written here at all. Nothing is
 * charged for them: `hire` takes the cost off `cash`, and this is not a
 * purchase, it is what the shop came with.
 *
 * It carries a **copy of the kind's `jobs`**, exactly as `hire` writes one, and
 * the reason is a trap worth keeping: leaving them off looks safe, because
 * `jobsOf` falls back to the kind's own authored list and the hire works
 * perfectly. The MENU does not fall back — it reads the row — so the shift
 * panel showed every directive at zero and a budget of 0/22, which is a hire
 * who is visibly doing their job over a panel saying they have been told to do
 * nothing. Copied rather than referenced, because from here the list is theirs.
 *
 * A kind that is not in the catalogue answers `null` and the shop opens with
 * nobody, which is the old game — a starter hire is not worth a broken save.
 *
 * And the name is the KIND's, deliberately, because `nameTheRoster` runs in the
 * constructor and renames anything still called after its job. Writing a real
 * name here would need the namer, which lives on a `Game` that does not exist
 * yet; writing this one hands the job to the code whose job it already is.
 */
const STARTER_KIND = 'shop-hand';

/**
 * ...AND A VAN ALREADY ON ITS WAY.
 *
 * The tour's third beat used to be "buy a case of something cheap", and its
 * seventh was "now go and pick it up" — with three beats in between chosen for
 * one reason, which is that they are the ones that do not need the stock. That
 * is a tutorial built around a delivery time: the ordering has to be taught
 * first whether or not it is the first thing worth teaching, and the beats
 * about your HANDS — which are the four gestures nothing else in the game
 * explains — have to wait for a lorry.
 *
 * A crate on the pad at minute zero unpicks all of it. The gestures can come
 * first because there is something to practise them on, and the supplier
 * becomes a beat about *where more comes from* rather than the thing standing
 * between you and the game.
 *
 * It is a real ORDER rather than a crate written onto the save, and that is the
 * whole of why this is cheap: the van drives, the crate lands on the pad the
 * shop actually painted, and `restoreOrders` turns `arrivesIn` back into a
 * stamp exactly as it does for one you placed yourself. Nothing here invents a
 * second way for goods to arrive — the trap `dropGoods` is named against.
 *
 * `cost: 0`, because this is what the shop came with rather than a purchase,
 * the same call the free Shop Hand makes.
 *
 * The item is chosen by TAGS and never by id: content is edited live, so naming
 * a row is a starting crate that silently stops existing the day somebody
 * deletes it. Two tags decide it and both are about the first ten minutes.
 * Nothing that needs a chiller or a warmer, because the shop owns neither yet
 * and a crate that can only go in a fixture you have not bought is a first
 * lesson you cannot finish. And `shelf-stable` ahead of cheap, which is the one
 * that is easy to leave out: the whole point of this crate is that it sits on
 * the pad while somebody reads, and a perishable one is a first delivery that
 * rots during the tutorial.
 */
function starterOrder() {
  const rows = Object.values(content().byId.items ?? {});
  const plain = rows
    .filter((i) => {
      const tags = i.tags ?? [];
      return !tags.includes('needs-freezer') && !tags.includes('needs-warmer');
    })
    .sort((a, b) => {
      const keeps = (i) => ((i.tags ?? []).includes('shelf-stable') ? 0 : 1);
      return keeps(a) - keeps(b) || (a.base_cost ?? 1e9) - (b.base_cost ?? 1e9);
    });
  const item = plain[0];
  if (!item) return null;
  return {
    item_id: item.id,
    qty: STARTER_CRATE,
    cost: 0,
    placedDay: 1,
    placedAt: PREP_HOUR,
    runHour: PREP_HOUR,
    // Not zero. The van has to be seen ARRIVING — a crate that is simply on the
    // pad when you look up is scenery, where one a lorry backs in and sets down
    // is the sentence "goods come on a van" said without a card.
    //
    // ...AND IT HAS TO LAND AFTER THE CARD THAT ASKS FOR IT, not before.
    //
    // This was 8, chosen so the crate was already on the pad by the time the
    // tour got to it. Both halves of that turned out to be wrong. The first
    // card is the establishing shot on the SHOPFRONT and the pad is round the
    // back, so a van that drives in during it is a lorry nobody was pointed at
    // — the one thing the wait exists to buy, spent where the camera is not.
    // And `take-all` already has a waiting beat written for it ("Waiting for
    // your delivery", the supplier in the well, the card breathing and the
    // stranded timer held off) which, arriving early, no player has ever seen.
    // So the crate is late on purpose: a few seconds of being told what is
    // happening, then a lorry to watch doing it.
    //
    // Seconds of `elapsed`, which is NOT real seconds here — a new shop opens
    // at `PREP_HOUR` and everything outside `daylight()` runs at `NIGHT_SPEED`,
    // so the first 30 of these go by in 10 and every one after that costs a
    // whole second. 34 is about fourteen seconds of sitting still, and the
    // crate is down at twenty: `loadVan` sets off at this stamp and the goods
    // land when the lorry has backed onto the pad, which is another six.
    //
    // Which is the whole width of the target. 8 was the card never seen; 40
    // was a wait you noticed you were in.
    arrivesIn: STARTER_WAIT,
    wait: STARTER_WAIT,
  };
}

/** One crate of it, and how long the first van takes, in seconds. */
const STARTER_CRATE = 12;
const STARTER_WAIT = 34;


function starterHire() {
  const kind = content().byId.workers[STARTER_KIND];
  if (!kind) return null;
  return {
    id: 'w1',
    kind: STARTER_KIND,
    tier: 1,
    name: kind.name,
    skin: null,
    jobs: withSpare((kind.jobs ?? []).map((j) => ({ job: j.job, weight: j.weight }))),
  };
}

/**
 * ...AND THEY ARRIVE WITH A POINT TO SPEND.
 *
 * `jobBudget` reads the kind's own authored total as its floor, so a hire
 * arrives at exactly their cap — which is right for a purchase and is the one
 * thing that made the shift panel unteachable. Every `+` in it is dead on the
 * frame it opens, so the first move the game can offer a new player on the one
 * panel that is about SPENDING something is a subtraction. The tour said so out
 * loud ("take one off a job they will not be doing"), which is a tutorial
 * apologising for a screen.
 *
 * So the starting hand is shaved by a point, and three things about where.
 *
 * It is the **copy** and never the row: `jobBudget`'s floor is `kind.jobs`, so
 * shaving the authored list would take the allowance down with it and leave the
 * hire at their cap again — the same 22 of 22, one point lighter, with nothing
 * gained. Shaving the copy leaves a real 21 of 22.
 *
 * It comes off the **smallest directive above 1**, last one wins, rather than
 * off a job named here. A job id in this file is `if (item.id === 'tomato')`
 * wearing a shift: the shop hand's list is content and can be re-authored
 * tomorrow, and a named job that had been dropped would silently shave nothing.
 * Smallest-above-1 is the least the shop loses; above 1 so no directive is ever
 * zeroed, since a job at 0 is a job they stop doing rather than one they do a
 * little less of.
 *
 * It is a **new shop's** hire only — this runs once, when the save is minted —
 * so nobody's live roster moves, and `simulate` against an existing world is
 * measuring the shop it was measuring before.
 */
function withSpare(jobs) {
  let at = -1;
  jobs.forEach((j, i) => {
    if (j.weight > 1 && (at < 0 || j.weight <= jobs[at].weight)) at = i;
  });
  if (at < 0) return jobs;
  return jobs.map((j, i) => (i === at ? { ...j, weight: j.weight - 1 } : j));
}

/**
 * Mint a save slot and the save behind it.
 *
 * The blank save is written here rather than left for `Game.create` so the menu
 * can show a brand new world's day and cash before anybody has opened it —
 * otherwise a world you just made reads as empty until you go in. That is also
 * what makes the starting numbers work: they have to be on the save *before*
 * the first `Game.create` reads it, because that is the read that stamps them
 * into a building.
 */
export function createWorld({
  name, seed, cash, tier, difficulty, surround, shelves, plots,
} = {}) {
  const label = cleanName(name, SHOP_NAME_MAX) || `Shop ${listWorldRows().length + 1}`;
  const id = mintId(label);
  const useSeed = String(seed ?? '').trim() || randomSeed();
  const start = startingState({
    cash: startingNumber(cash, START_LIMITS.cash),
    tier,
    difficulty,
    surround,
    shelves: startingNumber(shelves, START_LIMITS.shelves),
    plots: startingNumber(plots, START_LIMITS.plots),
  });

  const row = insertWorldRow({ id, name: label, seed: useSeed });
  /**
   * ...and it starts SHUT.
   *
   * The one line that makes opening up a thing you do rather than a thing the
   * clock does to you: the first act in a new shop is walking to the door and
   * raising the shutters, with a bare building and no shoppers in it while you
   * decide where the freezer goes.
   *
   * Written here rather than defaulted in `Game` on purpose, and the asymmetry
   * is the point. A save that has never heard of the field reads as OPEN, so
   * nobody's shop shuts itself on the day this shipped, and every headless game
   * — `simulate`, every `verify:*` sweep — trades exactly as it always did. Put
   * the default the other way round and a balance run measures a shop that never
   * opens, which reports as zero revenue with nothing in the output to say why.
   */
  /**
   * ...and it starts two hours BEFORE trading, which is the other half of the
   * same sentence.
   *
   * Shut at 08:00 with the town already out is a shop that is late; shut the
   * evening before is a shop that has not opened yet, and the two are the same
   * pixels with a different meaning on the clock. Written here for exactly the
   * reason `open: false` is — a save with nothing to say still reads as
   * mid-morning, so no headless game and no existing shop moves.
   *
   * It is a prep WINDOW now rather than the frame it was: `PREP_HOUR` is
   * closing time, so what a new shop starts with is the whole night — about a
   * minute of real time with the shutters down, against the ten seconds 06:00
   * bought. The line in `step` at 08:00 and the pulse on the sign still say the
   * shop is shut; this is what gives you time to do something about it.
   */
  /**
   * ...and the palette unfolds rather than arriving whole, which is the third
   * field written here for the reason the two above are.
   *
   * `shared/reveal.js` carries the argument. What matters at THIS end is the
   * asymmetry: a save that has never heard of the field reads as `false`, so
   * every shop that already exists keeps the bar it has been using — taking
   * twenty buttons off a day-322 shop is a regression wearing a feature — and
   * every headless game is untouched. Written `true` here, so the only shops
   * that ever ease in are ones that started after this shipped, which is the
   * only population the easing is for.
   */
  saveWorld(id, {
    ...DEFAULT_WORLD,
    seed: useSeed,
    open: false,
    time: PREP_HOUR / 24,
    reveal: true,
    ...start,
  });
  console.log(`[worlds] created "${label}" (${id}, seed ${useSeed}) `
    + `as a ${startTier(tier).name.toLowerCase()} on ${start.difficulty}: ${JSON.stringify(start)}`);
  return summarise(row);
}

export function renameWorld(id, name) {
  const label = cleanName(name, SHOP_NAME_MAX);
  if (!label) return null;
  const row = renameWorldRow(id, label);
  return row ? summarise(row) : null;
}

/**
 * Throw a world away, along with the room playing it.
 *
 * The room goes first and the row goes second. The other order leaves a live
 * room ticking a world with no save row, which persists happily to a key
 * nothing will ever read again and looks — from inside the game — completely
 * normal.
 *
 * **The last world may go too.** It used to be refused, on the grounds that a
 * menu with nothing in it is a dead end — but it isn't one: the list says "no
 * shops yet" and the button under it makes one, which is the same place a new
 * install starts. What the guard actually did was make deleting your shops
 * depend on the order you did it in, and leave the one you least wanted
 * (usually the throwaway you were testing with) as the one that would not go.
 */
export async function deleteWorld(id) {
  if (!worldRow(id)) return { ok: false, error: `no world "${id}"` };

  for (const room of roomsFor(id)) {
    // Ephemeral, so the dispose hook cannot write the save back over the delete.
    room.game.ephemeral = true;
    await room.disconnect();
  }
  if (focusedWorldId() === id) setWorld('focus', null);

  const gone = deleteWorldRow(id);
  if (gone) console.log(`[worlds] deleted "${id}"`);
  return { ok: gone, deleted: gone ? id : null };
}

/** Called when somebody joins. Keeps the menu's sort order honest. */
export function markPlayed(id) {
  if (worldRow(id)) touchWorldRow(id);
}

// ---------------------------------------------------------------------------
// Which world did you mean?
// ---------------------------------------------------------------------------

/**
 * The world MCP acts on when a call doesn't name one.
 *
 * Stored on the database rather than in a module variable so it survives the
 * `node --watch` restart that happens every time somebody saves a server file —
 * a pointer that resets itself mid-session is worse than no pointer, because it
 * silently goes back to poking whichever shop is busiest.
 *
 * It is shared. Both agents on this server read the same pointer, which is why
 * every route that resolves through it reports the world it landed on.
 */
export function focusedWorldId() {
  const id = getWorld('focus');
  return id && worldRow(id) ? id : null;
}

export function setFocus(id) {
  if (id === null) return setWorld('focus', null);
  if (!worldRow(id)) return null;
  setWorld('focus', id);
  return id;
}

/**
 * Resolve a world id from an explicit name, then the focus pointer, then the
 * busiest live room, then the most recently played save.
 *
 * The busiest-room step is what the control API did before any of this existed,
 * and it stays third so that an agent which never calls `use_world` keeps
 * behaving exactly as it used to.
 */
export function resolveWorldId(explicit) {
  if (explicit && worldRow(explicit)) return explicit;
  if (explicit) throw new Error(`no world "${explicit}" — call list_worlds to see what exists`);

  const focused = focusedWorldId();
  if (focused) return focused;

  const busiest = primaryRoom();
  if (busiest?.worldId && worldRow(busiest.worldId)) return busiest.worldId;

  // Rows come back most-recently-played first, so with nothing open at all this
  // is the shop you were in last — which is the one you meant.
  return listWorldRows()[0]?.id ?? null;
}

/**
 * The live room for a world, starting one if nobody has it open.
 *
 * Starting it is the point. Everything an agent does — reset a broken economy,
 * stock the shelves, run the director — used to need a browser tab open, which
 * meant "my world is bust" could only be fixed from inside the world. Now the
 * room boots headless, does the work, and the idle timer disposes it a few
 * minutes later.
 */
export async function roomForWorld(worldId) {
  const existing = roomsFor(worldId);
  if (existing.length) {
    // Prefer whichever has people in it — after a devMode restart there can
    // briefly be a stale empty room for the same world.
    return existing.reduce((a, b) => (b.clients.length > a.clients.length ? b : a));
  }
  if (!worldRow(worldId)) throw new Error(`no world "${worldId}"`);

  // Loaded here rather than at the top of the file, for the same reason the
  // import in `server/director.js` moved: this is the ONE line in this module
  // that needs a matchmaker, and a static import of it would make Colyseus a
  // hard dependency of listing, creating, renaming and deleting a shop — none
  // of which have ever needed one. In a build with no matchmaker this function
  // is simply never called: there is one room and it is already running.
  // `@vite-ignore` is load-bearing rather than decoration. A dynamic import is
  // still an edge in the module graph, so without it a browser bundle follows
  // this line into the whole Colyseus server and dies resolving `@pm2/io` — an
  // error naming a process-metrics package, from a file about save slots, with
  // nothing in it to suggest an import that is never executed there. Left
  // unresolved, it is a line this build never reaches: there is one room and it
  // is already running.
  const { matchMaker } = await import(/* @vite-ignore */ 'colyseus');
  await matchMaker.createRoom('mart', { worldId });
  const started = roomsFor(worldId);
  if (!started.length) throw new Error(`could not start world "${worldId}"`);
  return started[0];
}

/**
 * On boot: a brand new database gets a shop to walk into.
 *
 * The mark that it has done so is its own boolean, and it has to be — "does
 * this database have any worlds" is a different question, and answering it
 * instead hands you a shop back on the next boot every time you delete your
 * last one. In dev that is every file save, so a deliberate clean-out would
 * undo itself within seconds and read as the delete having silently failed.
 * Same trap, same shape, as `freezeYard`'s mark: see CLAUDE.md.
 */
export function ensureAWorld() {
  if (getWorld('worldsSeeded')) return null;
  setWorld('worldsSeeded', true);
  if (listWorldRows().length) return null;
  return createWorld({ name: 'First shop', seed: DEFAULT_WORLD.seed });
}

export { DEFAULT_WORLD_ID };
