/**
 * HIRED STAFF.
 *
 * The live game shipped with no NPC workers at all — the shopkeeper bot only
 * ever existed inside the headless balance runner, so an unattended shop just
 * filled up with shoppers holding baskets nobody would ever take money for.
 * These are the hires that make the shop run itself.
 *
 * Staff live in `game.players` on purpose. Every action method (`serve`,
 * `harvest`, `plant`, `buyStock`, `stockShelf`) already takes a player id and
 * enforces the same reach rules, and the client already draws everything in
 * `players` — so a hire obeys exactly the rules a human does, and shows up on
 * screen, without duplicating either system. They carry a `staff` role tag;
 * `stepPlayers` ignores them because they steer by path, not by input.
 */

import { content } from '../content.js';
import { followPath } from './pathing.js';
import { suggestedPrice, wholesalePrice } from './economy.js';

const STAFF_SPEED = 2.6;

/** Don't let a hire spend the shop down to nothing restocking. */
const CASH_FLOOR = 15;
const SPEND_FRACTION = 0.3;

/** Seconds between actions, so they look like workers rather than a script. */
const ACT_COOLDOWN = { clerk: 0.45, stocker: 0.8, farmhand: 0.7, chef: 0.7 };

const ROLE_COLOR = {
  clerk: '#4aa3a3',
  stocker: '#b07cc6',
  farmhand: '#7a9e4b',
  chef: '#d98b4a',
};
const ROLE_NAME = {
  clerk: 'Clerk', stocker: 'Stocker', farmhand: 'Farmhand', chef: 'Chef',
};

/** Which roles the shop currently employs, from owned staff upgrades. */
export function hiredRoles(game) {
  return content().upgrades
    .filter((u) => u.kind === 'staff' && game.ownedUpgrades.includes(u.id))
    .map((u) => u.payload?.role)
    .filter((r) => r && ROLE_NAME[r]);
}

/**
 * Add or remove staff entities so they match what's been hired. Cheap enough
 * to call every tick, which keeps it correct across restarts and refunds
 * without needing a hook on the purchase path.
 */
export function syncStaff(game) {
  const want = new Set(hiredRoles(game));

  for (const p of Object.values(game.players)) {
    if (p.staff && !want.has(p.staff)) delete game.players[p.id];
  }

  for (const role of want) {
    const id = `staff-${role}`;
    if (game.players[id]) continue;
    const spawn = game.layout.spawn;
    game.players[id] = {
      id,
      name: ROLE_NAME[role],
      staff: role,
      x: spawn.x,
      z: spawn.z - 1,
      facing: 0,
      color: ROLE_COLOR[role],
      carry: null,
      input: null,   // steered by path, so stepPlayers skips them
      path: null,
      cooldown: 0,
      job: null,
    };
    game.pushLog(`${ROLE_NAME[role]} started their shift.`);
  }
}

/** Drive every hire one tick. Never throws — a stuck hire must not stall the sim. */
export function stepStaff(game, dt) {
  syncStaff(game);

  for (const s of Object.values(game.players)) {
    if (!s.staff) continue;
    s.cooldown = Math.max(0, s.cooldown - dt);

    // Walking to a job takes priority over picking a new one.
    if (s.path && s.path.length) {
      followPath(s, STAFF_SPEED, dt);
      continue;
    }

    if (s.cooldown > 0) continue;

    try {
      if (s.staff === 'clerk') stepClerk(game, s);
      else if (s.staff === 'stocker') stepStocker(game, s);
      else if (s.staff === 'farmhand') stepFarmhand(game, s);
      else if (s.staff === 'chef') stepChef(game, s);
    } catch {
      // A broken job is not worth killing the tick loop over.
      s.job = null;
      s.cooldown = 1;
    }
  }
}

/** Walk to `goal`; returns true once standing there. */
function goTo(game, s, goal, reach = 1.2) {
  if (Math.hypot(s.x - goal.x, s.z - goal.z) <= reach) return true;
  if (!game.pathTo(s, goal)) {
    s.cooldown = 1;   // unreachable — try something else shortly
    return false;
  }
  return false;
}

/**
 * Nowhere legal to put what they're holding: walk it out to the bay and crate
 * it. Staff used to just have the goods deleted out of their hands, which meant
 * an over-full shop quietly binned every harvest. Now the stock survives, sits
 * somewhere visible, and can be dealt with by a human.
 */
function putDown(game, s) {
  if (!goTo(game, s, game.layout.bay, 1.6)) return;
  const res = game.stow(s.id);
  if (!res.ok) { s.carry = null; s.cooldown = 2; return; }
  s.cooldown = ACT_COOLDOWN[s.staff] ?? 1;
}

// ---------------------------------------------------------------------------
// Clerk — stands behind the till and takes money.
// ---------------------------------------------------------------------------

function stepClerk(game, s) {
  const tills = game.layout.checkouts;
  if (!tills.length) return;

  // Prefer a till that actually has someone standing in it ready to pay.
  const ready = (t) => (t.queue ?? []).some((id) => game.customers[id]?.state === 'QUEUE');
  const till = tills.find(ready) ?? tills[0];

  // Behind the counter: one tile into the shop from the till itself, which is
  // never where a shopper stands (they queue on the far side).
  const post = { x: till.x, z: till.z - 1 };

  if (!goTo(game, s, post, 0.6)) return;

  // Take the money off the counter first — that's the job.
  const picked = game.collectCash(s);
  if (picked > 0) {
    s.cooldown = ACT_COOLDOWN.clerk;
    return;
  }

  if (!ready(till)) return;
  const res = game.serve(s.id, till.id);
  s.cooldown = res.ok ? ACT_COOLDOWN.clerk : 0.5;
}

// ---------------------------------------------------------------------------
// Stocker — keeps shelves full from the supplier.
// ---------------------------------------------------------------------------

function stepStocker(game, s) {
  const c = content();

  // Holding something? Get it onto a shelf before starting anything new.
  if (s.carry) {
    const shelf = shelfFor(game, s.carry.item_id, c);
    if (!shelf) return putDown(game, s);            // nowhere legal to put it
    if (!goTo(game, s, shelf.browseAt ?? shelf)) return;
    game.stockShelf(s.id, shelf.id);
    s.cooldown = ACT_COOLDOWN.stocker;
    return;
  }

  // Anything already sitting at the bay gets unloaded before ordering more —
  // otherwise the stocker keeps buying while pallets pile up outside. Only
  // crates they can actually find a home for, though: picking up goods with
  // nowhere to go just puts them straight back down again, forever.
  const pallet = game.deliveries.find((d) => shelfFor(game, d.item_id, c));
  if (pallet) {
    if (!goTo(game, s, pallet, 1.4)) return;
    const res = game.unload(s.id, pallet.id);
    s.cooldown = res.ok ? ACT_COOLDOWN.stocker : 1;
    return;
  }

  const budget = (game.cash - CASH_FLOOR) * SPEND_FRACTION;
  if (budget <= 0) { s.cooldown = 2; return; }

  // The emptiest shelf first — an empty shelf is a customer walking out.
  const target = game.layout.shelves
    .filter((sh) => sh.qty <= 2)
    .sort((a, b) => a.qty - b.qty)[0];
  if (!target) { s.cooldown = 2; return; }

  const item = target.item_id
    ? c.byId.items[target.item_id]
    : pickItem(game, target, c);
  if (!item) { s.cooldown = 2; return; }

  const unit = wholesalePrice(item, game.folded(), game.season);
  // Orders arrive as a pallet now, so they aren't capped by what one pair of
  // hands can hold — the stocker just makes more trips.
  const qty = Math.min(
    item.stack - target.qty,
    Math.floor(budget / Math.max(unit, 0.01))
  );
  if (qty <= 0) { s.cooldown = 2; return; }

  const bought = game.buyStock(s.id, item.id, qty);
  if (!bought.ok) { s.cooldown = 2; return; }
  s.cooldown = ACT_COOLDOWN.stocker;
}

/** A shelf that will legally accept this item. */
function shelfFor(game, itemId, c) {
  const item = c.byId.items[itemId];
  if (!item) return null;
  const needsFreezer = item.tags.includes('needs-freezer') || item.tags.includes('frozen');
  const usable = game.layout.shelves.filter((sh) => {
    if (needsFreezer && sh.kind !== 'freezer') return false;
    if (!needsFreezer && sh.kind === 'freezer') return false;
    if (sh.qty > 0 && sh.item_id !== itemId) return false;
    return sh.qty < item.stack;
  });
  // Top up a shelf already holding it before claiming an empty one.
  return usable.sort((a, b) => (b.item_id === itemId) - (a.item_id === itemId))[0] ?? null;
}

/** Best unstocked item for an empty shelf: margin weighted by who wants it. */
function pickItem(game, shelf, c) {
  const folded = game.folded();
  const already = new Set(game.layout.shelves.map((sh) => sh.item_id).filter(Boolean));

  const crafted = new Set(c.recipes.map((r) => r.output_id));

  const scored = c.items
    .filter((it) => {
      if (crafted.has(it.id)) return false;   // the chef makes these
      const frozen = it.tags.includes('needs-freezer') || it.tags.includes('frozen');
      return frozen ? shelf.kind === 'freezer' : shelf.kind !== 'freezer';
    })
    .map((it) => {
      const margin = suggestedPrice(it, folded, game.season) - wholesalePrice(it, folded, game.season);
      const pull = c.archetypes.reduce((sum, a) => {
        let d = 0;
        for (const t of it.tags) d += a.affinities[t] ?? 0;
        return sum + Math.max(0, d) * a.spawn_weight;
      }, 0);
      return { it, score: margin * (0.5 + pull) };
    })
    .sort((a, b) => b.score - a.score);

  // Spread across the range rather than putting the same winner everywhere.
  return (scored.find((x) => !already.has(x.it.id)) ?? scored[0])?.it ?? null;
}

// ---------------------------------------------------------------------------
// Farmhand — plants, harvests, and walks the produce to a shelf.
// ---------------------------------------------------------------------------

function stepFarmhand(game, s) {
  const c = content();

  if (s.carry) {
    const shelf = shelfFor(game, s.carry.item_id, c);
    if (!shelf) return putDown(game, s);
    if (!goTo(game, s, shelf.browseAt ?? shelf)) return;
    game.stockShelf(s.id, shelf.id);
    s.cooldown = ACT_COOLDOWN.farmhand;
    return;
  }

  const ripe = game.layout.plots.find((p) => p.ready);
  if (ripe) {
    if (!goTo(game, s, ripe)) return;
    game.harvest(s.id, ripe.id);
    s.cooldown = ACT_COOLDOWN.farmhand;
    return;
  }

  // Sow first, turn second. A bed that's already broken is one action from
  // producing, so finishing it beats starting a new one — and doing it the
  // other way round leaves a farmhand tilling the whole field before planting
  // a single seed.
  const sowable = game.layout.plots.find((p) => !p.crop_id && p.soil === 'tilled');
  if (sowable) {
    const crop = pickCrop(game, c);
    if (!crop) { s.cooldown = 3; return; }
    if (!goTo(game, s, sowable)) return;
    game.plant(s.id, sowable.id, crop.id);
    s.cooldown = ACT_COOLDOWN.farmhand;
    return;
  }

  const rough = game.layout.plots.find((p) => !p.crop_id && p.soil !== 'tilled');
  if (!rough) { s.cooldown = 2; return; }
  // Don't break ground the shop can't afford to sow — an all-tilled, all-empty
  // field is worse than an untouched one.
  if (!pickCrop(game, c)) { s.cooldown = 3; return; }
  if (!goTo(game, s, rough)) return;
  game.till(s.id, rough.id);
  s.cooldown = ACT_COOLDOWN.farmhand;
}

// ---------------------------------------------------------------------------
// Chef — works the appliances: gathers ingredients, loads them, shelves the
// finished product.
// ---------------------------------------------------------------------------

function stepChef(game, s) {
  const c = content();
  const stations = game.layout.stations ?? [];
  if (!stations.length) { s.cooldown = 3; return; }

  // 1. Something finished? Get it out and onto a shelf.
  const done = stations.find((st) => st.output);
  if (done && !s.carry) {
    if (!goTo(game, s, done.useAt)) return;
    game.collectStation(s.id, done.id);
    s.cooldown = ACT_COOLDOWN.chef;
    return;
  }

  // 2. Holding a finished product -> shelve it. Holding an ingredient an
  //    appliance wants -> tip it in.
  if (s.carry) {
    const needing = stations.find((st) => wants(game, st).has(s.carry.item_id));
    if (needing) {
      if (!goTo(game, s, needing.useAt)) return;
      const res = game.loadStation(s.id, needing.id);
      s.cooldown = res.ok ? ACT_COOLDOWN.chef : 1;
      return;
    }
    const shelf = shelfFor(game, s.carry.item_id, c);
    if (!shelf) return putDown(game, s);
    if (!goTo(game, s, shelf.browseAt ?? shelf)) return;
    game.stockShelf(s.id, shelf.id);
    s.cooldown = ACT_COOLDOWN.chef;
    return;
  }

  // 3. Empty handed: fetch an ingredient some appliance is short of, off a
  //    shelf. Only take what the shop can spare so the chef doesn't strip a
  //    shelf customers are buying from.
  // Least-loaded appliance first, so one machine doesn't hog the chef.
  const idle = stations
    .filter((st) => !st.making && !st.output)
    .sort((a, b) => total(a.contents) - total(b.contents));

  for (const st of idle) {
    const recipe = feasibleRecipe(game, st);
    if (!recipe) continue;
    for (const input of recipe.inputs) {
      const short = input.qty - (st.contents[input.item_id] ?? 0);
      if (short <= 0) continue;
      const shelf = game.layout.shelves.find((sh) => sh.item_id === input.item_id && sh.qty > 0);
      if (!shelf) continue;
      if (!goTo(game, s, shelf.browseAt ?? shelf)) return;
      // Take only the shortfall — hoarding an ingredient strips a shelf
      // customers are still buying from.
      const take = Math.min(short, shelf.qty, game.carryCapacity());
      shelf.qty -= take;
      s.carry = { item_id: input.item_id, qty: take };
      s.cooldown = ACT_COOLDOWN.chef;
      return;
    }
  }
  s.cooldown = 2;
}

const total = (contents) => Object.values(contents ?? {}).reduce((a, b) => a + b, 0);

/** Ingredients this appliance could still use. */
function wants(game, st) {
  return new Set(game.recipesFor(st.station).flatMap((r) => r.inputs.map((i) => i.item_id)));
}

/**
 * The recipe this appliance can actually finish right now — every missing
 * ingredient has to be sitting on a shelf somewhere.
 *
 * Picking purely by "fewest items missing" deadlocks: the chef commits to the
 * nearly-complete recipe, discovers its last ingredient isn't stocked, and
 * never falls back to the one it could have made from what's on the shelves.
 */
function feasibleRecipe(game, st) {
  const stock = new Map();
  for (const sh of game.layout.shelves) {
    if (sh.item_id && sh.qty > 0) stock.set(sh.item_id, (stock.get(sh.item_id) ?? 0) + sh.qty);
  }

  const options = game.recipesFor(st.station)
    .map((r) => ({
      r,
      short: r.inputs.reduce((n, i) => n + Math.max(0, i.qty - (st.contents[i.item_id] ?? 0)), 0),
      possible: r.inputs.every((i) => {
        const need = i.qty - (st.contents[i.item_id] ?? 0);
        return need <= 0 || (stock.get(i.item_id) ?? 0) >= need;
      }),
    }))
    .filter((o) => o.possible)
    .sort((a, b) => a.short - b.short);

  return options[0]?.r ?? null;
}

/**
 * Choose a seed weighted by value per minute. Always planting the single best
 * crop is a monoculture — the slower ones then never reach a shelf at all.
 */
function pickCrop(game, c) {
  const folded = game.folded();
  const budget = (game.cash - CASH_FLOOR);
  if (budget <= 0) return null;

  const options = c.crops
    .filter((cr) => !cr.seasons.length || cr.seasons.includes(game.season))
    .filter((cr) => cr.seed_cost <= budget)
    .map((cr) => {
      const item = c.byId.items[cr.item_id];
      if (!item) return null;
      const avgYield = (cr.yield_min + cr.yield_max) / 2;
      const value = suggestedPrice(item, folded, game.season) * avgYield;
      return { cr, score: (value - cr.seed_cost) / Math.max(cr.grow_minutes, 0.01) };
    })
    .filter((o) => o && o.score > 0);

  if (!options.length) return null;

  const total = options.reduce((sum, o) => sum + o.score, 0);
  let r = game.rng.next() * total;
  for (const o of options) {
    r -= o.score;
    if (r <= 0) return o.cr;
  }
  return options[options.length - 1].cr;
}
