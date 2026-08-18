/**
 * WHAT MAKES A NOISE — the snapshot, diffed.
 *
 * Every sound in the game is triggered from here, and the reason it is a *diff*
 * rather than a set of hooks scattered through the client is docs/audio.md's
 * one hard rule about sourcing: **the events do not come from the log.**
 *
 * `state.log` is tempting, because the lines are already written and already
 * say what happened. It is a rolling eight-line window inside a snapshot — a
 * picture, not a stream — and `ui.js` reads only the newest line and only when
 * its text differs from the last one it saw. Three sales in one tick surface
 * one line; two identical lines in a row surface one. That is exactly right for
 * a corner feed nobody should have to read, and exactly wrong for a till that
 * should ring three times. It is also *prose*, so matching on it means a sound
 * effect that stops working because somebody reworded a message.
 *
 * A diff has none of that. A snapshot is a picture of now, so two pictures
 * always differ correctly, and a dropped frame costs you one sound rather than
 * desynchronising a stream.
 *
 * The one thing a picture genuinely cannot carry is an *event* — a milestone
 * passed, an action refused. Those already have their own messages (`achieved`,
 * `action-result`), for the reason `net.js` spells out, and they are wired in
 * `main.js` beside their existing handlers rather than guessed at here.
 */

import { sfx } from './sfx.js';

/**
 * What finishing each kind of action sounds like.
 *
 * Keyed off `p.action.kind`, which is the thing the ring is already winding
 * for — so the sound lands exactly when the ring completes, and an action you
 * walked away from makes none. Anything not listed here is silent on purpose: a
 * shop where every verb has its own noise is the slot machine the caps exist to
 * prevent.
 */
const ON_FINISH = {
  harvest: 'harvest',
  till: 'confirm',
  sow: 'putdown',
  stock: 'putdown',
  unshelve: 'pickup',
  take: 'pickup',
  crate: 'crate',
  stow: 'crate',
  serve: 'sale',
};

/**
 * How far through an action counts as having finished it.
 *
 * An action that vanishes from the snapshot has either completed or been
 * abandoned, and those look identical one frame later. Walking away throws the
 * charge away at whatever progress it had reached, so anything past most of the
 * way is a completion — and the cost of being wrong either way is one sound.
 */
const DONE_AT = 0.6;

/**
 * Where a shopper's patience turns into a noise.
 *
 * `anger` is 0..1 off `angerOf` — 0 is content, 1 is fuming — so these are two
 * marks on one dial rather than two states the sim keeps. Crossing `ANNOYED_AT`
 * is a warning you can still act on; leaving at or above `ANGRY_AT` is the
 * thing that already cost you reputation.
 *
 * Crossings are one-way on purpose. A shopper hovering either side of a line
 * would otherwise tick at you every time their mood breathed, and `stepMood`
 * moves continuously — the sound is for the moment it got worse, and it should
 * not be able to happen twice for the same person without them calming down
 * properly first.
 */
const ANNOYED_AT = 0.35;
const CALM_AGAIN = 0.22;
const ANGRY_AT = 0.6;

/** Gap between the two beeps of the van's reverser, in ms. */
const BEEP_GAP = 240;

/**
 * How rarely a hire may chirp, in ms.
 *
 * Far longer than the ordinary dedupe window, because this is the one sound in
 * the game that scales with your *staff* rather than with anything you did. A
 * shop with five hires changes jobs constantly and none of it is news — the
 * chirp is there so the place sounds inhabited, not so you can audit a rota.
 */
const CHIRP_EVERY = 2600;

/**
 * How much of the robot burble one chirp is, in seconds.
 *
 * The file is five seconds of a machine muttering to itself, which as a whole
 * is a machine *starting up* rather than a machine acknowledging you. Three
 * tenths is one syllable of it, and since the slice is taken from a random
 * place each time, one recording is worth a dozen different chirps. It is what
 * you HEAR, so it stays put when the pitch moves — see `dur` in `sfx.play`.
 */
const CHIRP = 0.3;

/**
 * A stable 0..1 from a string.
 *
 * Used to give each hire its own pitch, so the same robot always sounds like
 * itself. A hash rather than a draw, for the reason CLAUDE.md gives about kits:
 * anything cosmetic and per-person must not touch the measured rng stream —
 * and here it must not touch any stream at all, since a reload that repitched
 * everybody would read as the shop having hired different robots.
 */
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

class Events {
  constructor() {
    this.drops = new Set();
    this.crates = new Set();
    this.action = null;
    this.progress = 0;
    this.carry = null;
    this.haul = null;
    this.mood = new Map();
    this.where = new Map();
    this.vanPhase = null;
    this.jobs = new Map();
    this.tiers = null;
    this.owned = null;
    this.seeded = false;
  }

  /**
   * A tier moved — the one thing the snapshot cannot tell you.
   *
   * A rung up or down changes no count and no position, so the `fixtures` diff
   * in `update` is blind to it: upgrading a checkout is a $420 press that
   * looked, sounded and read as nothing happening. Tiers ride on the `layout`
   * message instead, which is re-sent whenever `layoutVersion` bumps — so this
   * hangs off that rather than off the 10Hz snapshot.
   *
   * The arrays are walked generically rather than named. `layout` grows a new
   * kind of fixture every few weeks (`stations`, then `props`), and a hardcoded
   * list is a kind whose ladder is silently mute — which is the same shape as
   * the `FIXTURE_KINDS` bugs in CLAUDE.md, where anything enumerating kinds by
   * hand is a place a new kind dies quietly.
   *
   * **Keyed by TILE, not by id**, which is the whole reason this did not work
   * the first time. `upgradeFixture` goes through `repositionFixture`, which
   * mints `fx-${nextFixtureId}` — so a rung up is not a fixture whose tier
   * changed, it is one id disappearing and a different one arriving one tier
   * higher, and a diff by id sees a stranger and says nothing. The fixture menu
   * already knew this: CLAUDE.md notes it has to follow its fixture through a
   * re-flow because "a fixture that was turned comes back with a new id on the
   * same tile". The tile is the thing that holds still.
   *
   * Moving a fixture is therefore silent, and correctly so: the old tile goes
   * and the new one has no previous tier to differ from.
   */
  layout(payload) {
    const L = payload?.layout ?? payload;
    if (!L || typeof L !== 'object') return;

    const tiers = new Map();
    for (const arr of Object.values(L)) {
      if (!Array.isArray(arr)) continue;
      for (const f of arr) {
        if (!f || typeof f !== 'object' || f.tier == null || f.x == null) continue;
        tiers.set(`${f.x},${f.z}`, { tier: f.tier, x: f.x, z: f.z });
      }
    }

    // The first layout of a session is the shop as it already is, not a shop
    // that just upgraded seventeen things — same reason `update` seeds silently.
    if (this.tiers) {
      // One sound per re-flow, and the order below is the priority. A single
      // press moves exactly one fixture, so anything that would fire twice
      // means the whole shop re-flowed — and a shop whose every shelf announced
      // itself is the slot machine the caps exist to prevent.
      const gained = [...tiers.keys()].filter((k) => !this.tiers.has(k));
      const lost = [...this.tiers.keys()].filter((k) => !tiers.has(k));

      const moved = tiers.size === this.tiers.size && gained.length && lost.length;
      const rung = [...tiers].find(([k, now]) => {
        const was = this.tiers.get(k);
        return was && was.tier !== now.tier;
      });

      if (rung) {
        // A rung first, because it is the only one of the three that is not
        // already obvious on screen — the unit does not move and does not
        // appear, it just quietly becomes worth more.
        const [, now] = rung;
        sfx.play(now.tier > this.tiers.get(`${now.x},${now.z}`).tier ? 'upgrade' : 'downgrade', now);
      } else if (moved) {
        // Same number of fixtures, different tiles: something was picked up and
        // put back down somewhere else. It lands, so it thuds.
        sfx.play('place', tiers.get(gained[0]));
      } else if (gained.length > lost.length) {
        sfx.play('place', tiers.get(gained[0]));
      } else if (lost.length > gained.length) {
        sfx.play('remove', this.tiers.get(lost[0]));
      }
    }
    this.tiers = tiers;
  }

  /**
   * One snapshot in, some noises out.
   *
   * The **first** snapshot of a session seeds the baseline and plays nothing.
   * Without that, joining a shop with fourteen crates on the pad and money on
   * three counters is fourteen crate thumps and three tills in one frame — a
   * diff against nothing is a diff in which the entire world just happened.
   */
  update(state, myId) {
    if (!state) return;

    const me = state.players?.find((p) => p.id === myId) ?? null;
    if (me) sfx.listenAt(me.x, me.z);

    const drops = new Set((state.cashDrops ?? []).map((d) => d.id));
    const crates = new Set((state.deliveries ?? []).map((d) => d.id));

    if (!this.seeded) {
      this.seeded = true;
      this.drops = drops;
      this.crates = crates;
      this.rememberShoppers(state);
      this.vanPhase = state.van?.phase ?? null;
      this.owned = (state.ownedUpgrades ?? []).length;
      this.rememberJobs(state);
      this.remember(me);
      return;
    }

    // Money appearing on a counter is somebody being served — the single best
    // "people are doing things" signal the shop has, because it only happens
    // when a sale actually completed.
    for (const d of state.cashDrops ?? []) {
      if (!this.drops.has(d.id)) sfx.play('sale', d);
    }
    // ...and money leaving is you having walked over it. `stepCashPickup` is
    // the one action in the game nobody has ever wanted to decline, so it is
    // also the one that is always worth confirming.
    for (const id of this.drops) {
      if (!drops.has(id)) { sfx.play('coins', me); break; }
    }

    // A crate landing. Deliveries, a stripped shelf, an armful put down — one
    // entity, one noise, which is the same argument `dropGoods` makes about
    // there only being one kind of goods-on-the-floor.
    for (const d of state.deliveries ?? []) {
      if (!this.crates.has(d.id)) sfx.play('crate', d);
    }

    // A shop-wide upgrade off the Upgrades bar. The same noise a fixture rung
    // makes, because from the player's side it is the same press: money for a
    // better shop. It only ever goes up — there is no way back off one — which
    // is why this counts rather than diffing.
    const owned = (state.ownedUpgrades ?? []).length;
    if (this.owned != null && owned > this.owned) sfx.play('upgrade', me);
    this.owned = owned;

    // A hire picking up a new job. They are machines, so they chirp — and each
    // one is pitched by a hash of who it is, so you can tell the stocker from
    // the farmhand without looking up. Rate-limited hard: see `CHIRP_EVERY`.
    for (const p of state.players ?? []) {
      if (!p.staff || p.id === myId) continue;
      const job = p.job ?? null;
      const was = this.jobs.get(p.id);
      if (job && was !== undefined && was !== job) {
        // 0.55..0.8 — pitched well down, because at natural speed this reads as
        // a computer terminal in a film rather than as something standing in a
        // shop. The spread is what tells two robots apart; the floor is what
        // makes them sound like machinery rather than a modem.
        sfx.play('robot', p, {
          rate: 0.55 + hash01(p.id) * 0.25, every: CHIRP_EVERY, dur: CHIRP,
        });
        break;
      }
    }
    this.rememberJobs(state);

    // Somebody running out of patience, and somebody who already has.
    //
    // Both are the case docs/audio.md was written for: a shopper gives up in an
    // aisle you are not looking at, and the only report has ever been a line in
    // the corner feed that ages out in seven seconds. A walkout is *already*
    // costing reputation by the time you could have seen it.
    for (const c of state.customers ?? []) {
      const was = this.mood.get(c.id);
      const now = c.anger ?? 0;
      if (was != null && was < ANNOYED_AT && now >= ANNOYED_AT) sfx.play('annoyed', c);
    }
    // The id set is built once rather than asked per departure. `.some()` inside
    // this loop is O(n²) over the shoppers in the shop, ten times a second — at
    // a dozen customers that is free and invisible, and at a hundred it is ten
    // thousand comparisons a tick for a sound that fires when somebody leaves.
    // The loop that scales with the shop is the one worth writing properly.
    const here = new Set((state.customers ?? []).map((c) => c.id));
    for (const [id, seen] of this.mood) {
      // Gone from the snapshot: served and left, wandered off, or stormed out.
      // Only the last of those is worth a noise, and how angry they were the
      // last time anybody looked is the only evidence left of which it was.
      if (seen >= ANGRY_AT && !here.has(id)) {
        sfx.play('angry', this.where.get(id));
        break;
      }
    }

    // The lorry backing onto the pad. On the transition rather than while it
    // reverses, because `in` lasts as long as the drive does and a beeper that
    // ran for all of it is a beeper you would mute the game over. Twice, with a
    // gap wider than the dedupe window — one beep is a blip, two is a vehicle.
    const phase = state.van?.phase ?? null;
    if (phase === 'unload' && this.vanPhase === 'in') {
      sfx.play('beep', state.van);
      setTimeout(() => sfx.play('beep', state.van), BEEP_GAP);
    }
    this.vanPhase = phase;

    // What you were doing, the moment you stop doing it.
    const kind = me?.action?.kind ?? null;
    if (this.action && kind !== this.action && this.progress >= DONE_AT) {
      const id = ON_FINISH[this.action];
      if (id) sfx.play(id, me);
    }

    // Hands, for everything that fills or empties them without an action —
    // picking a crate off a pile, a shelf board tapped for one unit.
    const carry = me?.carry?.item_id ?? null;
    if (carry && carry !== this.carry && !this.action) sfx.play('pickup', me);
    const haul = me?.haul ? 'y' : null;
    if (haul && !this.haul) sfx.play('crate', me);

    this.drops = drops;
    this.crates = crates;
    this.rememberShoppers(state);
    this.remember(me);
  }

  /**
   * Everyone's patience, and where they were standing.
   *
   * The position is kept beside the anger because the sound for a walkout has
   * to be played at somebody who is, by definition, no longer in the snapshot —
   * without it the one event that most needs a direction plays dead centre.
   *
   * `CALM_AGAIN` is below `ANNOYED_AT` rather than equal to it, which is the
   * hysteresis: stored at the lower mark, somebody sitting exactly on the line
   * cannot re-cross it on the next tick.
   */
  rememberJobs(state) {
    const jobs = new Map();
    for (const p of state.players ?? []) {
      if (p.staff) jobs.set(p.id, p.job ?? null);
    }
    this.jobs = jobs;
  }

  rememberShoppers(state) {
    const mood = new Map();
    const where = new Map();
    for (const c of state.customers ?? []) {
      const now = c.anger ?? 0;
      mood.set(c.id, now < CALM_AGAIN ? 0 : now);
      where.set(c.id, { x: c.x, z: c.z });
    }
    this.mood = mood;
    this.where = where;
  }

  remember(me) {
    this.action = me?.action?.kind ?? null;
    this.progress = me?.action?.progress ?? 0;
    this.carry = me?.carry?.item_id ?? null;
    this.haul = me?.haul ? 'y' : null;
  }
}

export const events = new Events();
