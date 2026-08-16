/**
 * HEADLESS BALANCE RUNNER.
 *
 * Runs the whole economy for N in-game days with no renderer and no humans,
 * driven by a competent-but-not-genius bot shopkeeper. Comes back with the
 * numbers that actually matter: did you make money, what sold, what rotted,
 * who walked out empty-handed.
 *
 * This is the single most useful thing an agent can call. Balance is invisible
 * from reading code — "is coffee priced right?" is only answerable by running
 * it. 100 in-game days takes about a second here.
 *
 * It runs on a throwaway Game (never the live one) so calling it can't disturb
 * anybody's session.
 */

import { Game, DAY_SECONDS, OPEN_HOUR, CLOSE_HOUR } from './index.js';
import { content } from '../content.js';
import { wholesalePrice, suggestedPrice, departmentMeter } from './economy.js';
import { requiredFixture } from '../../shared/tags.js';
import { canPlaceCleanly } from '../../shared/build.js';
import { WALKABLE } from '../../shared/tiles.js';

/**
 * @param {object} opts
 * @param {string} opts.worldId    which save slot to copy the shop from
 * @param {number} opts.days       in-game days to run
 * @param {string} opts.seed       world seed (reproducible)
 * @param {number} opts.startCash
 * @param {number} opts.priceMult  bot's markup vs suggested price (1 = suggested)
 * @param {number} opts.dt         sim step in seconds; bigger = faster + coarser
 */
export function simulate({
  worldId,
  days = 30,
  seed = 'sim',
  startCash = 250,
  priceMult = 1,
  dt = 0.25,
} = {}) {
  const c = content();
  if (c.items.length === 0) {
    return { ok: false, error: 'no items exist — seed the database first' };
  }

  const game = Game.create({ worldId, seed, autoServe: true, ephemeral: true });

  // What this run inherited from the live shop. `Game.create` reads the saved
  // world, so who already works here and what the shop already owns come along
  // for the ride — and two runs that differ in those are not comparable however
  // equal their seeds are. That cost an afternoon to work out once, so the
  // numbers now say it out loud.
  //
  // `world` joined it the day save slots did, for exactly the same reason: two
  // runs of one seed against two different shops are two different experiments,
  // and nothing else in the result would ever tell you which shop you measured.
  const startedWith = {
    world: worldId,
    staff: (game.roster ?? []).map((e) => e.name),
    ownedUpgrades: game.ownedUpgrades.length,
  };

  game.cash = startCash;
  game.day = 1;
  game.time = OPEN_HOUR / 24;
  game.autoServe = true;

  const bot = game.addPlayer('bot', 'Bot');

  const daily = [];
  let dayCursor = game.day;
  let dayStartCash = game.cash;
  let peakCash = game.cash;
  let bankruptOn = null;
  const totals = {
    revenue: 0, spent: 0, sold: 0, abandoned: 0,
    spoiled: 0, harvested: 0, tilled: 0, leftEmpty: 0, turnedAway: 0, byItem: {},
    unmet: {}, impulse: 0,
    // The demand meter's two tallies over the whole run. `unmet` below is the
    // same territory narrowed to staples-missed-entirely; these are the whole
    // exchange, which is what tells a department that served nine asks out of ten
    // apart from one nobody has ever asked for.
    asked: {}, served: {}, moved: {},
  };

  // Run until the calendar says so, not until a step count says so. A day used
  // to be exactly DAY_SECONDS of stepping, so `days * DAY_SECONDS / dt` was the
  // same statement — it stopped being true the moment the closed hours started
  // running at 6×, and a run asked for 60 days would quietly have done 103.
  // `endDay` is the guard against a clock that never advances.
  const endDay = game.day + days;
  const maxSteps = Math.ceil((days * DAY_SECONDS * 2) / dt);

  for (let i = 0; game.day < endDay && i < maxSteps; i++) {
    game.step(dt);
    // The bot acts a few times a second, not every step — it's a shopkeeper,
    // not a machine gun.
    if (i % Math.max(1, Math.round(1 / dt)) === 0) runBot(game, bot, priceMult);

    if (game.day !== dayCursor) {
      daily.push({
        day: dayCursor,
        cash: round2(game.cash),
        profit: round2(game.cash - dayStartCash),
        reputation: round2(game.reputation),
      });
      accumulate(totals, game._lastDayStats ?? {});
      dayStartCash = game.cash;
      dayCursor = game.day;
      peakCash = Math.max(peakCash, game.cash);
      if (game.cash < 0 && bankruptOn === null) bankruptOn = dayCursor;
    }
  }

  // Which items never sold a single unit? Usually a tagging or pricing bug.
  // Crafted goods are excluded: the balance bot doesn't work the appliances, so
  // flagging them here would report a tagging problem that doesn't exist.
  const sold = totals.byItem;
  const craftedIds = new Set(c.recipes.map((r) => r.output_id));
  const deadStock = c.items
    .filter((it) => !sold[it.id] && !craftedIds.has(it.id))
    .map((it) => it.id);
  const uncraftedUnsold = c.items
    .filter((it) => !sold[it.id] && craftedIds.has(it.id))
    .map((it) => it.id);

  const bestSellers = Object.entries(sold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, qty]) => ({ id, qty }));

  // What people came in for and you never had. Unlike `deadStock` — which says
  // "this item is wrong" — this says "this demand exists and nothing on your
  // shelves answers it", which is a shopping list rather than a bug report.
  const unmetDemand = Object.entries(totals.unmet)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));

  // The demand meter, over the run instead of over a smoothed day — the same
  // function the HUD draws, handed the whole-run tallies. `folded` is deliberately
  // neutral: a world event that was live for three of forty days would stretch
  // every bar as though it had been live for all of them, and a balance report is
  // the one place that must describe the shop rather than the weather.
  //
  // Boards are read at the *end*, because that is the shop the run left behind —
  // and a bar is only ever a judgement on shelf space as it stands now.
  const departments = departmentMeter({
    asked: totals.asked,
    served: totals.served,
    moved: totals.moved,
    boards: game.departmentBoards(),
    folded: { demand: {}, price: {} },
  }).filter((d) => d.net !== 0 || d.boards > 0);

  const finalCash = round2(game.cash);
  const profit = round2(finalCash - startCash);

  return {
    ok: true,
    seed,
    days,
    priceMult,
    startCash,
    finalCash,
    profit,
    profitPerDay: round2(profit / days),
    peakCash: round2(peakCash),
    bankruptOn,
    reputation: round2(game.reputation),
    totals: {
      revenue: round2(totals.revenue),
      spent: round2(totals.spent),
      sold: totals.sold,
      harvested: totals.harvested,
      tilled: totals.tilled,
      abandoned: totals.abandoned,
      spoiled: totals.spoiled,
      leftEmpty: totals.leftEmpty,
      impulse: totals.impulse,
    },
    bestSellers,
    deadStock,
    unmetDemand,
    departments,
    daily: daily.slice(-30),
    startedWith,
    verdict: [
      ...verdict({ profit, days, bankruptOn, totals, deadStock, uncraftedUnsold, unmetDemand, departments }),
      ...(startedWith.staff.length
        ? [`Started with ${startedWith.staff.join(', ')} already on the books — a run that inherited different staff is not comparable to this one.`]
        : []),
    ],
  };
}

/**
 * What the bot keeps in the till whatever else it wants.
 *
 * The shop opens with $250 and restocking is the thing that has to keep
 * happening; everything else — a hire, an extension, another aisle — can wait
 * a day. Spending past this is how a good shop becomes an empty one.
 */
const FLOAT = 250;

/**
 * A plain-language read on the run, so an agent doesn't have to interpret
 * raw numbers to know whether something's wrong.
 */
function verdict({
  profit, days, bankruptOn, totals, deadStock,
  uncraftedUnsold = [], unmetDemand = [], departments = [],
}) {
  const notes = [];
  if (bankruptOn) notes.push(`BANKRUPT on day ${bankruptOn} — the shop cannot sustain itself.`);
  else if (profit <= 0) notes.push(`Lost $${Math.abs(profit).toFixed(2)} over ${days} days — costs exceed revenue.`);
  else notes.push(`Profitable: $${profit.toFixed(2)} over ${days} days.`);

  if (totals.abandoned > totals.sold * 0.25 && totals.abandoned > 5) {
    notes.push(`High abandonment (${totals.abandoned}) — queues are too slow.`);
  }
  if (totals.spoiled > totals.sold * 0.2 && totals.spoiled > 5) {
    notes.push(`Heavy spoilage (${totals.spoiled} units) — perishables are overstocked or shelf life is too short.`);
  }
  if (totals.leftEmpty > totals.sold * 0.3 && totals.leftEmpty > 5) {
    notes.push(`${totals.leftEmpty} customers found nothing they wanted — shelf variety or pricing is off.`);
  }
  if (deadStock.length) {
    notes.push(`Never sold: ${deadStock.join(', ')} — check their tags match some archetype's affinities.`);
  }
  if (unmetDemand.length) {
    const top = unmetDemand.slice(0, 4).map((u) => `${u.tag} (${u.count})`).join(', ');
    notes.push(`Came in for it and you had none: ${top}. Stock something tagged that way — this is demand you already have.`);
  }
  if (uncraftedUnsold.length) {
    notes.push(`Not modelled: ${uncraftedUnsold.join(', ')} are crafted goods — this bot doesn't work the appliances, so hire a Chef and watch the live shop to judge them.`);
  }
  // The two halves of the demand meter, said out loud. Separate notes rather than
  // one, because they are separate jobs: the first is a shopping list, the second
  // is shelf space to take back, and a shop can very easily need both at once.
  const short = departments.filter((d) => d.net >= 0.25).map((d) => d.dept);
  if (short.length) {
    notes.push(`Short on ${short.join(', ')} — asked for more than the shelves answered over the run.`);
  }
  const idle = departments.filter((d) => d.net <= -0.25 && d.boards > 0)
    .map((d) => `${d.dept} (${d.boards})`);
  if (idle.length) {
    notes.push(`Shelf space not earning: ${idle.join(', ')} — boards held for departments that barely sold. Relabel them.`);
  }
  return notes;
}

/**
 * The bot shopkeeper. Deliberately simple and readable — if you change the
 * game's rules, change this too or your balance numbers will quietly lie.
 */
/** Pick one entry with probability proportional to its `score`. */
function weightedByScore(pool, rng) {
  const total = pool.reduce((s, o) => s + o.score, 0);
  let r = rng.next() * total;
  for (const o of pool) {
    r -= o.score;
    if (r <= 0) return o;
  }
  return pool[pool.length - 1];
}

function runBot(game, bot, priceMult) {
  const c = content();
  const folded = game.folded();

  // Reserve a slice of the shop for farm output. Without this the wholesale
  // step below claims every empty shelf first and the harvest has nowhere to
  // land — which silently turns the entire farm into compost.
  const farmGrown = new Set(c.crops.map((cr) => cr.item_id));
  const plainShelves = game.layout.shelves.filter((s) => s.kind !== 'freezer');
  const reserveCount = Math.min(farmGrown.size, Math.floor(plainShelves.length / 2));
  const reserved = new Set(plainShelves.slice(0, reserveCount).map((s) => s.id));

  // 1. Plant every empty plot, spreading across the in-season crops we can
  //    afford rather than filling the whole farm with the single best-scoring
  //    one. Monoculture meant a slower crop was never planted, never harvested
  //    and never shelved — so it showed up as `deadStock` and read as a tagging
  //    bug when the tags were fine.
  //
  //    Pick proportional to value rather than always taking the best. Always
  //    planting the top crop is a monoculture — the slower crops never reach a
  //    shelf and get reported as dead stock when their tags are fine. Strict
  //    round-robin overcorrects and hands half the farm to the worst crop, so
  //    weight by score: good crops still dominate, everything gets grown.
  const chooseCrop = () => {
    const options = c.crops
      .filter((cr) => !cr.seasons.length || cr.seasons.includes(game.season))
      .filter((cr) => cr.seed_cost <= game.cash * 0.25)
      .map((cr) => {
        const item = c.byId.items[cr.item_id];
        if (!item) return null;
        const avgYield = (cr.yield_min + cr.yield_max) / 2;
        const value = suggestedPrice(item, folded, game.season) * avgYield;
        return { cr, score: (value - cr.seed_cost) / cr.grow_minutes };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    if (!options.length) return null;
    const pool = options.filter((o) => o.score > 0);
    return pool.length ? weightedByScore(pool, game.rng) : options[0];
  };

  for (const plot of game.layout.plots) {
    if (plot.crop_id) continue;
    // Seed needs broken soil now. Without this the bot's farm silently stops
    // producing and every crop shows up as `deadStock` — a tagging bug that
    // isn't one, which is exactly the false signal this tool exists to avoid.
    if (plot.soil !== 'tilled') {
      teleport(bot, plot);
      game.till('bot', plot.id);
    }
    const pick = chooseCrop();
    if (!pick) break;

    teleport(bot, plot);
    game.plant('bot', plot.id, pick.cr.id);
  }

  // 2. Harvest anything ready.
  //
  //    Harvesting now auto-replants the same crop, so a plot is never empty
  //    again and the planting pass above would never revisit it — every bed
  //    frozen on whatever it was first sown with, which is the monoculture
  //    that pass exists to prevent, resurfacing as a false `deadStock`.
  //    So the choice is re-made here, at the one instant the new crop has
  //    cost nothing: growth is exactly 0 the tick it goes in, so swapping it
  //    destroys no value, and anything part-grown is never touched.
  for (const plot of game.layout.plots) {
    if (!plot.ready) continue;
    teleport(bot, plot);

    // Say what should go back in BEFORE picking, the same way a player does by
    // holding a seed. Harvesting then replants that. Letting it replant the
    // old crop and correcting afterwards buys two seeds per switch, which is
    // not what a player does and would price the feature far worse than it is.
    const pick = chooseCrop();
    bot.selectedCrop = pick ? pick.cr.id : null;

    game.harvest('bot', plot.id);
    if (bot.carry) dumpCarryToShelf(game, bot, priceMult, reserved);
  }

  // 3. Refill thin BOARDS by buying wholesale — but never the reserved shelves.
  //
  //    A unit holds one kind per board now, so a shopkeeper fills boards rather
  //    than shelves: a shelf with a full top row and two bare ones underneath is
  //    two thirds empty, and a bot that judged the unit would walk past it. It
  //    also has to open the boards it is not using, or the shop would run on one
  //    kind per shelf for ever and this whole change would measure as nothing.
  for (const shelf of game.layout.shelves) {
    if (reserved.has(shelf.id)) continue;
    const boards = game.shelfBoards(shelf);
    for (let b = 0; b < boards; b++) {
      const stacks = game.shelfStacks(shelf);
      // The thinnest board it already has, or a new one if there is room.
      const thin = stacks.slice().sort((x, y) => x.qty - y.qty)[0] ?? null;
      // Only add a KIND once everything already on the unit is stocked. The
      // bot's own rule about shelving, applied one level down — "a shopkeeper
      // extends the shop when the shop ran out" — and it has to be here or the
      // instrument breaks: told to fill every board on day one, the bot spends
      // three times as much on wholesale as it can carry against a $250 float
      // and bankrupts itself by day 26. Measured. The shelves are not what went
      // broke; holding variety constant, the new code lands within noise of the
      // old (-245/-217/-256 against -224/-234/-242 over the same three seeds).
      const opening = stacks.length < boards
        && stacks.every((k) => k.qty > 2)
        && game.cash > 400;
      const wanted = (!opening && thin) ? c.byId.items[thin.item_id]
        : pickItemForShelf(game, shelf, folded);
      if (!wanted) break;
      const have = game.shelfStack(shelf, wanted.id)?.qty ?? 0;
      if (have > 2 && !opening) break;

      const unit = wholesalePrice(wanted, folded, game.season);
      const affordable = Math.floor((game.cash * 0.3) / Math.max(unit, 0.01));
      // Against the BOARD's room, which is a share of the unit — ordering a
      // whole stack for one board of three sends two thirds of it straight back
      // out to a crate on the floor.
      const qty = Math.min(game.carryCapacity(),
        game.shelfCapacity(shelf, wanted) - have, affordable);
      if (qty <= 0) break;

      if (bot.carry && bot.carry.item_id !== wanted.id) dumpCarryToShelf(game, bot, priceMult, reserved);
      const bought = game.buyStock('bot', wanted.id, qty);
      if (!bought.ok) break;

      teleport(bot, shelf.browseAt);
      const res = game.stockShelf('bot', shelf.id);
      if (!res.ok) break;
      game.setPrice(shelf.id, suggestedPrice(wanted, folded, game.season) * priceMult, wanted.id);
      // ONE order per unit per turn, exactly as before boards existed. Filling
      // every board in one pass makes the bot spend three times as fast as the
      // shopkeeper it is supposed to model, which is a bot bankrupting itself
      // rather than a shop that cannot pay — and the run reports the second.
      break;
    }
  }

  // 4. Keep prices tracking the current market (events move fair value). Every
  //    board, each priced as itself — one price per unit would have the cheese
  //    sold at the milk's price.
  for (const shelf of game.layout.shelves) {
    for (const stack of game.shelfStacks(shelf)) {
      const item = c.byId.items[stack.item_id];
      if (item) game.setPrice(shelf.id, suggestedPrice(item, folded, game.season) * priceMult, item.id);
    }
  }

  // 5. Spend surplus on ONE thing, cheapest first — a hire, an upgrade, or a
  //    fixture put down somewhere.
  //
  //    Staff and upgrades have to compete in a single queue. When hiring was an
  //    upgrade they did automatically; splitting them into two steps quietly
  //    doubled the shop's daily spend, and it went on staff while the shelves
  //    it needed to fill them stayed unbought.
  //
  //    And it hires for *coverage*, not one of each kind: a shop with a clerk
  //    does not need a second person whose only trick is serving. Without this
  //    the bot's wage bill grows every time anyone authors a new kind of
  //    worker, and every balance run since would read as a regression.
  //
  //    Building joined the same queue in step 9, and it had to: shelves and
  //    plots used to arrive as upgrade *packs*, so a shop grew by buying from a
  //    menu. It grows by building now, and a bot that never built would have
  //    measured a shop frozen at its opening-day shelving for a hundred days —
  //    while cheerfully buying discounts on fixtures it never put down.
  const covered = new Set((game.roster ?? [])
    .flatMap((e) => e.jobs ?? [])
    .map((j) => j.job));
  const options = [
    ...c.workers
      .filter((w) => w.jobs.some((j) => !covered.has(j.job)))
      .map((w) => ({ cost: w.cost, buy: () => game.hire(w.id) })),
    ...c.upgrades
      .filter((u) => u.kind !== 'staff')
      .filter((u) => !game.ownedUpgrades.includes(u.id))
      .filter((u) => u.requires.every((r) => game.ownedUpgrades.includes(r)))
      .map((u) => ({ cost: u.cost, buy: () => game.buyUpgrade(u.id) })),
    ...buildOptions(game, bot),
  ]
    // A fraction of the till, and never into the float. The fraction was the
    // only gate for a long time and it was enough only because the bot could
    // barely spend: with the queue unwedged, one $650 extension on a slow seed
    // took a shop below zero, and below zero it can no longer buy stock — so
    // the shelves empty, nobody finds anything, and it never comes back. That
    // read as "the shop cannot sustain itself" on 1 seed in 10, which is a bot
    // with no working capital rather than an economy that doesn't work.
    .filter((o) => o.cost < game.cash * 0.4 && game.cash - o.cost > FLOAT)
    .sort((a, b) => a.cost - b.cost);

  //    Down the list until something works, rather than at the cheapest and no
  //    further. That is not tidiness: `buyUpgrade` refuses a whole class of row
  //    (an appliance is bought in build mode), and taking the head of the queue
  //    on faith meant one refusal wedged the bot's entire progression — it
  //    bought a rucksack on day two and then nothing, ever, because the next
  //    cheapest thing was one it could never have. A hundred days of a shop
  //    that never hires and never grows, reported as the economy.
  for (const o of options) {
    if (o.buy()?.ok) break;
  }
}

/**
 * What the bot could build, and where it would put it.
 *
 * A deliberately dim shopkeeper: it wants more shelves than anything, digs a
 * bed when the farm is smaller than the shop floor, and adds a till when one is
 * visibly not keeping up. It never tears anything out, never rearranges, and
 * never buys a decoration — a bot that redecorated would measure taste.
 *
 * Priced through `fixtureUnitCost` rather than off the catalog, so a discount
 * the bot has bought changes what it thinks a shelf costs and therefore when it
 * buys one, which is the whole point of the deals it can now own.
 */
function buildOptions(game, bot) {
  const out = [];
  const shelves = game.layout.shelves.length;
  const plots = game.layout.plots.length;
  const tills = game.layout.checkouts.length;

  // Yesterday's complaints, which is the only honest reason to build anything.
  // The first version of this built whatever was cheapest whenever it could
  // afford it — a shelf every in-game second, because a shelf is the cheapest
  // thing in the game — and by day sixty the shop was a hundred-and-forty
  // aisles nobody could walk down, stocked at random. Sales fell by three
  // quarters and the run reported a catastrophe that was entirely the bot's
  // doing. A shopkeeper extends the shop when the shop ran out, so:
  const last = game._lastDayStats ?? {};
  const sold = last.sold ?? 0;
  // A unit with a spare board is not full, so "we have run out of shelving" has
  // to be asked of boards — otherwise the bot buys aisles it has not filled.
  const empties = game.layout.shelves
    .filter((s) => game.shelfStacks(s).length < game.shelfBoards(s)
      || game.shelfStacks(s).some((k) => k.qty === 0)).length;

  // Shoppers who wanted something and found nothing. More shelving is only an
  // answer to that once the shelving you have is full — otherwise the problem
  // is stocking, and another empty unit makes it worse.
  if (empties === 0 && (last.leftEmpty ?? 0) > Math.max(3, sold * 0.05)) want('shelf');
  // Beds, when every one you have is in the ground and the shop has room for
  // what they grow. Half the shelving is the farm's share — the rest is bought
  // in, and a farm bigger than that just rots.
  if (plots * 2 < shelves && game.layout.plots.every((p) => p.crop_id)) want('plot');
  // A till, when the queues are visibly costing sales.
  if (tills < 4 && (last.abandoned ?? 0) > Math.max(3, sold * 0.08)) want('checkout');

  // The *price* is cheap to know and the *spot* is not, so the option carries
  // the price and finds the spot only if it wins. Scanning up front instead
  // looked identical and ran a full-map reachability flood per candidate cell,
  // several times per in-game second — a sixty-day run stopped finishing.
  function want(kind) {
    out.push({
      cost: game.fixtureUnitCost(kind),
      buy: () => {
        const spot = buildSpot(game, kind);
        if (!spot) return { ok: false, error: 'nowhere to put one' };
        // Build mode is consent, and the bot has to give it the same way a
        // player does — `placeFixture` refuses outright otherwise, which would
        // wedge the queue exactly the way a refused upgrade used to.
        game.setBuildMode(bot.id, true, kind);
        const res = game.placeFixture(bot.id, { kind, x: spot.x, z: spot.z, rot: spot.rot });
        game.setBuildMode(bot.id, false);
        return res;
      },
    });
  }
  return out;
}

/**
 * The first place a fixture of this kind would legally go, or null.
 *
 * Cleanly, so the bot never talks itself into walling off its own aisle — a
 * warning is a choice a player gets to make, and this one is not equipped to
 * make it. Scanned in reading order rather than packed optimally: a bot that
 * tessellated its shop would measure a layout nobody plays.
 *
 * The memo is not a micro-optimisation. A full shop answers "nowhere" only
 * after walking every cell, and it answers it again a second later, and a
 * second after that, for the rest of the run — the answer can only change when
 * the layout does, so it is cached against `layoutVersion` and one entry deep.
 */
const spotMemo = new Map();
let spotMemoVersion = -1;

function buildSpot(game, kind) {
  if (game.layoutVersion !== spotMemoVersion) {
    spotMemo.clear();
    spotMemoVersion = game.layoutVersion;
  } else if (spotMemo.has(kind)) {
    return spotMemo.get(kind);
  }

  const L = game.layout;
  let found = null;
  outer:
  for (let z = 1; z < L.h - 1 && !found; z++) {
    for (let x = 1; x < L.w - 1; x++) {
      if (!WALKABLE.has(L.tiles[z * L.w + x])) continue;
      for (const rot of ROTATIONS) {
        if (canPlaceCleanly(L, { kind, x, z, rot }).ok) { found = { x, z, rot }; break outer; }
      }
    }
  }
  spotMemo.set(kind, found);
  return found;
}

const ROTATIONS = [0, 1, 2, 3];

/** Choose something sensible to put on an empty shelf. */
function pickItemForShelf(game, shelf, folded) {
  const c = content();
  // Anything the farm produces arrives free, so don't waste cash buying it
  // wholesale — leave those shelves for the harvest.
  const farmGrown = new Set(c.crops.map((cr) => cr.item_id));

  // Crafted goods can't be ordered from the supplier, so the bot must not try
  // to shelve them — it would price in stock that never arrives.
  const crafted = new Set(c.recipes.map((r) => r.output_id));

  let candidates = c.items.filter((it) => {
    if (crafted.has(it.id)) return false;
    const fixture = requiredFixture(it);
    if (fixture === 'freezer') return shelf.kind === 'freezer';
    return shelf.kind !== 'freezer';
  });
  const bought = candidates.filter((it) => !farmGrown.has(it.id));
  if (bought.length) candidates = bought;
  if (!candidates.length) return null;

  // Prefer margin, but weight by how many archetypes actually want it —
  // otherwise the bot stocks high-margin things nobody buys.
  const scored = candidates.map((it) => {
    const margin = suggestedPrice(it, folded, game.season) - wholesalePrice(it, folded, game.season);
    const wanted = c.archetypes.reduce((s, a) => {
      let d = 0;
      for (const tag of it.tags) d += a.affinities[tag] ?? 0;
      return s + Math.max(0, d) * a.spawn_weight;
    }, 0);
    return { it, score: margin * (0.5 + wanted) };
  }).sort((a, b) => b.score - a.score);

  // Don't put the same thing on every shelf.
  const already = new Set(game.layout.shelves
    .flatMap((s) => game.shelfStacks(s).map((k) => k.item_id)).filter(Boolean));
  return (scored.find((s) => !already.has(s.it.id)) ?? scored[0]).it;
}

function dumpCarryToShelf(game, bot, priceMult, reserved = new Set()) {
  if (!bot.carry) return;
  const c = content();
  const item = c.byId.items[bot.carry.item_id];
  if (!item) { bot.carry = null; return; }
  const fixture = requiredFixture(item);

  const usable = game.layout.shelves.filter((s) => {
    if (fixture === 'freezer' && s.kind !== 'freezer') return false;
    if (fixture !== 'freezer' && s.kind === 'freezer') return false;
    return true;
  });

  // Prefer a shelf already holding this item, then any empty one. Free produce
  // from the farm should always beat leaving a shelf bare.
  // A board already holding it with room, then a reserved unit with a spare
  // board, then any unit with a spare board. Free produce from the farm should
  // always beat leaving a board bare.
  const room = (s) => (game.shelfStack(s, item.id)?.qty ?? 0) < game.shelfCapacity(s, item);
  const spare = (s) => game.shelfStacks(s).length < game.shelfBoards(s);
  const target = usable.find((s) => game.shelfStack(s, item.id) && room(s))
    ?? usable.find((s) => reserved.has(s.id) && spare(s))
    ?? usable.find((s) => spare(s));

  if (!target) { bot.carry = null; return; }

  teleport(bot, target.browseAt);
  const res = game.stockShelf('bot', target.id);
  if (res.ok) {
    game.setPrice(target.id, suggestedPrice(item, game.folded(), game.season) * priceMult, item.id);
  }
  else bot.carry = null;
}

/**
 * The bot doesn't walk — it blinks to whatever it's working on.
 * Walking time is a real gameplay cost for humans, but modelling it here would
 * make balance runs measure the bot's pathing rather than the economy.
 */
function teleport(bot, target) {
  bot.x = target.x;
  bot.z = target.z;
}

function accumulate(totals, s) {
  for (const k of ['revenue', 'spent', 'sold', 'abandoned', 'spoiled', 'harvested', 'tilled', 'leftEmpty', 'impulse']) {
    totals[k] += s[k] ?? 0;
  }
  for (const [id, n] of Object.entries(s.byItem ?? {})) {
    totals.byItem[id] = (totals.byItem[id] ?? 0) + n;
  }
  // Every tag-keyed tally, by the same rule, rather than one loop each. The list
  // above is explicit on purpose — a scalar that gains a key silently starts
  // reporting `undefined` — but these four are all "map of tag to a count", so a
  // fifth costs a word here instead of five lines.
  for (const key of ['unmet', 'asked', 'served', 'moved']) {
    for (const [tag, n] of Object.entries(s[key] ?? {})) {
      totals[key][tag] = (totals[key][tag] ?? 0) + n;
    }
  }
}

const round2 = (v) => Math.round(v * 100) / 100;
