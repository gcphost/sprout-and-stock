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
import { wholesalePrice, suggestedPrice } from './economy.js';
import { requiredFixture } from '../../shared/tags.js';

/**
 * @param {object} opts
 * @param {number} opts.days       in-game days to run
 * @param {string} opts.seed       world seed (reproducible)
 * @param {number} opts.startCash
 * @param {number} opts.priceMult  bot's markup vs suggested price (1 = suggested)
 * @param {number} opts.dt         sim step in seconds; bigger = faster + coarser
 */
export function simulate({
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

  const game = Game.create({ seed, autoServe: true, ephemeral: true });

  // What this run inherited from the live shop. `Game.create` reads the saved
  // world, so who already works here and what the shop already owns come along
  // for the ride — and two runs that differ in those are not comparable however
  // equal their seeds are. That cost an afternoon to work out once, so the
  // numbers now say it out loud.
  const startedWith = {
    staff: (game.roster ?? []).map((e) => e.name),
    ownedUpgrades: game.ownedUpgrades.length,
  };

  game.cash = startCash;
  game.day = 1;
  game.time = OPEN_HOUR / 24;
  game.autoServe = true;

  const bot = game.addPlayer('bot', 'Bot');
  // Actions need the button held now. The bot is a stand-in for someone working
  // flat out, so it holds permanently — without this it silently loses every
  // action it used to get from proximity alone, and the numbers move for a
  // reason that has nothing to do with the economy.
  bot.holdInput = true;

  const daily = [];
  let dayCursor = game.day;
  let dayStartCash = game.cash;
  let peakCash = game.cash;
  let bankruptOn = null;
  const totals = {
    revenue: 0, spent: 0, sold: 0, abandoned: 0,
    spoiled: 0, harvested: 0, tilled: 0, leftEmpty: 0, byItem: {},
  };

  const totalSteps = Math.ceil((days * DAY_SECONDS) / dt);

  for (let i = 0; i < totalSteps; i++) {
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
    },
    bestSellers,
    deadStock,
    daily: daily.slice(-30),
    startedWith,
    verdict: [
      ...verdict({ profit, days, bankruptOn, totals, deadStock, uncraftedUnsold }),
      ...(startedWith.staff.length
        ? [`Started with ${startedWith.staff.join(', ')} already on the books — a run that inherited different staff is not comparable to this one.`]
        : []),
    ],
  };
}

/**
 * A plain-language read on the run, so an agent doesn't have to interpret
 * raw numbers to know whether something's wrong.
 */
function verdict({ profit, days, bankruptOn, totals, deadStock, uncraftedUnsold = [] }) {
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
  if (uncraftedUnsold.length) {
    notes.push(`Not modelled: ${uncraftedUnsold.join(', ')} are crafted goods — this bot doesn't work the appliances, so hire a Chef and watch the live shop to judge them.`);
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

  // 3. Refill empty shelves by buying wholesale — but never the reserved ones.
  for (const shelf of game.layout.shelves) {
    if (shelf.qty > 2 || reserved.has(shelf.id)) continue;

    const wanted = shelf.item_id
      ? c.byId.items[shelf.item_id]
      : pickItemForShelf(game, shelf, folded);
    if (!wanted) continue;

    const unit = wholesalePrice(wanted, folded, game.season);
    const affordable = Math.floor((game.cash * 0.3) / Math.max(unit, 0.01));
    const qty = Math.min(game.carryCapacity(), wanted.stack - shelf.qty, affordable);
    if (qty <= 0) continue;

    if (bot.carry && bot.carry.item_id !== wanted.id) dumpCarryToShelf(game, bot, priceMult, reserved);
    const bought = game.buyStock('bot', wanted.id, qty);
    if (!bought.ok) continue;

    teleport(bot, shelf.browseAt);
    const res = game.stockShelf('bot', shelf.id);
    if (res.ok) game.setPrice(shelf.id, suggestedPrice(wanted, folded, game.season) * priceMult);
  }

  // 4. Keep prices tracking the current market (events move fair value).
  for (const shelf of game.layout.shelves) {
    if (!shelf.item_id) continue;
    const item = c.byId.items[shelf.item_id];
    if (item) game.setPrice(shelf.id, suggestedPrice(item, folded, game.season) * priceMult);
  }

  // 5. Spend surplus on ONE thing, cheapest first — a hire or an upgrade.
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
  ]
    .filter((o) => o.cost < game.cash * 0.4)
    .sort((a, b) => a.cost - b.cost);
  if (options.length) options[0].buy();
}

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
  const already = new Set(game.layout.shelves.map((s) => s.item_id).filter(Boolean));
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
  const target = usable.find((s) => s.item_id === item.id && s.qty < item.stack)
    ?? usable.find((s) => reserved.has(s.id) && s.qty === 0)
    ?? usable.find((s) => s.qty === 0);

  if (!target) { bot.carry = null; return; }

  teleport(bot, target.browseAt);
  const res = game.stockShelf('bot', target.id);
  if (res.ok) game.setPrice(target.id, suggestedPrice(item, game.folded(), game.season) * priceMult);
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
  for (const k of ['revenue', 'spent', 'sold', 'abandoned', 'spoiled', 'harvested', 'tilled', 'leftEmpty']) {
    totals[k] += s[k] ?? 0;
  }
  for (const [id, n] of Object.entries(s.byItem ?? {})) {
    totals.byItem[id] = (totals.byItem[id] ?? 0) + n;
  }
}

const round2 = (v) => Math.round(v * 100) / 100;
