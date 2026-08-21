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
import { pieceFor } from '../../shared/pieces.js';
import { variantSfx } from '../../shared/model.js';

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
  // Setting a box or an armful down on a square you named. It made its noise
  // through the crate-on-the-floor diff below until that diff was retired, and
  // it is the one drop in the game with no other tell — `stow` at least lands
  // on the pad you were walking to.
  setdown: 'crate',
  serve: 'sale',
};

/**
 * There used to be a `DONE_AT` here, and it is worth knowing why it is gone.
 *
 * An action that vanishes from the snapshot has either completed or been
 * abandoned, and those look identical one frame later — so this file called
 * anything past 60% of the ring a completion and played the sound. The cost of
 * being wrong was described as "one sound", and that is true only if a sound is
 * not evidence. It is: walking away is how you decline in this game, so
 * declining LATE played the noise of having done it, and what you are left with
 * is a shop that made the shelving sound and did not shelve anything. There is
 * nothing else on screen to contradict it.
 *
 * `p.acts` on the player record is the shop's own count of jobs that fired, and
 * the sound reads that. The general shape: a client that INFERS an outcome will
 * be wrong at exactly the moments the player is unsure, which is when they are
 * relying on it most.
 */

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
    /**
     * Who has already been shouted about — see docs/security.md step 2.
     *
     * A set of ids rather than a count, because the alert is about a PERSON and
     * a shop can have two thieves in it at once: a counter would shout for the
     * first and go quiet for the second, which is the one that would actually
     * get away with it. Never cleared while they are on the map, so a thief
     * crossing the shop is one alert rather than one every frame.
     */
    this.thieves = new Set();
    this.action = null;
    this.acts = 0;
    this.carry = null;
    this.haul = null;
    this.mood = new Map();
    this.where = new Map();
    this.vanPhase = null;
    this.jobs = new Map();
    this.tiers = null;
    this.owned = null;
    this.seeded = false;
    /** The catalog, for the `sfx` block on a piece. Set by `setCatalog`. */
    this.pieces = [];
    /**
     * Everything standing in the shop that has a `loop` authored, worked out
     * once per re-flow rather than ten times a second — see `hummers`.
     */
    this.hummers = [];
  }

  /**
   * The catalog, which is where the noise a fixture makes now comes from.
   *
   * Handed in rather than imported, because the catalog is a live thing that
   * arrives on the wire and can be re-sent: somebody authoring an appliance in
   * the other window should be able to give it a hum without either of you
   * reloading. `layout` is re-derived when it lands for exactly that reason.
   */
  setCatalog(catalog) {
    this.pieces = catalog?.fixtures ?? [];
    if (this.layoutSeen) this.findHummers(this.layoutSeen);
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
    this.findHummers(L);
  }

  /**
   * Which fixtures in the shop have a noise authored, and which of them have to
   * be WORKING to make it.
   *
   * Done here rather than in `update` because it is a question about the
   * building, and the building changes on a re-flow — where the snapshot
   * arrives ten times a second and would re-walk every fixture in the shop
   * against every catalog row to learn nothing. What `update` is left with is
   * the one question that genuinely moves: is this machine running.
   *
   * **The list is keyed by tile**, for the reason the tiers above are: a rung
   * or a turn re-mints the fixture's id on the same square, and a loop keyed by
   * id would stop and restart on every one — which, since building re-flows on
   * every wall segment of a drag, is a fridge that stutters continuously while
   * you extend the shop. See `sfx.setLoops`.
   *
   * The `work` test is the rule `sfxShape` states: a thing that knows what
   * working means hums while it works, and a thing that does not hums always.
   * It asks the piece for a `work` model rather than asking whether the kind is
   * `station`, because that is the same question content already answers — and
   * a kind list written out here is one more place a new kind dies quietly.
   */
  findHummers(L) {
    this.layoutSeen = L;
    const out = [];
    for (const [kind, arr] of Object.entries(L ?? {})) {
      if (!Array.isArray(arr)) continue;
      for (const f of arr) {
        if (!f || f.x == null) continue;
        const piece = pieceFor(this.pieces, { ...f, kind: f.kind ?? kind });
        // Through the VARIANT, which is the difference between a kitchen and one
        // machine you can hear from anywhere: every appliance in the game is a
        // shape of one `station` row, so a sound read off the piece alone is the
        // same note eleven times over. Falls back to the piece, so nothing that
        // never authored a shape changes.
        const sfxOf = variantSfx(piece, f.variant);
        const id = sfxOf?.loop;
        if (!id) continue;
        out.push({
          key: `${f.x},${f.z}`,
          id,
          rate: sfxOf.rate ?? 1,
          at: { x: f.x, z: f.z },
          // A machine with a working look is a machine with a working sound.
          working: !!piece.work,
        });
      }
    }
    this.hummers = out;
  }

  /**
   * The loops that should be sounding right now.
   *
   * A list rather than starts and stops, because that is the only shape a
   * snapshot can honestly produce — see `sfx.setLoops` for why a hook per
   * machine leaks a hum into an empty shop the first time a frame goes missing.
   *
   * A paused world is silent. The renderer already has to be told the same
   * thing (`scene.paused`), and for the same reason: both of these run on the
   * page's clock rather than the shop's, so a fridge humming under a stopped
   * game reads exactly as the pause not working — which is what a blade still
   * turning read as.
   */
  loops(state) {
    if (state.paused) return sfx.setLoops([]);
    // Only a machine that is mid-batch, and `making` is the shop's own answer
    // rather than one inferred from progress: a batch that has just finished
    // and one that never started both read as progress 0.
    const busy = new Set((state.stations ?? [])
      .filter((s) => s.making)
      .map((s) => `${s.x},${s.z}`));
    return sfx.setLoops(this.hummers.filter((h) => !h.working || busy.has(h.key)));
  }

  /**
   * One snapshot in, some noises out.
   *
   * The **first** snapshot of a session seeds the baseline and plays nothing.
   * Without that, joining a shop with money on three counters and a shopper
   * mid-storm-out is three tills and an alarm in one frame — a diff against
   * nothing is a diff in which the entire world just happened.
   */
  update(state, myId, onAlarm = null) {
    if (!state) return;

    const me = state.players?.find((p) => p.id === myId) ?? null;
    if (me) sfx.listenAt(me.x, me.z);

    // Before the seeding return below, and deliberately: a loop is not an event
    // and has nothing to diff. Joining a shop with three fridges in it should
    // sound like a shop with three fridges in it from the first frame, where a
    // seeded diff exists so that joining does not sound like everything in the
    // shop happening at once.
    this.loops(state);

    const drops = new Set((state.cashDrops ?? []).map((d) => d.id));

    if (!this.seeded) {
      this.seeded = true;
      this.drops = drops;
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

    /**
     * Somebody has just walked off with your stock.
     *
     * The loudest thing the shop can say, and the only one that is about a
     * person rather than a thing. It fires on the COMMIT — the tick `stole`
     * appears on the wire — rather than on the spawn, because a shop that
     * flagged a thief as they came through the door would have read their mind
     * and thrown away the whole decision this exists to hand you.
     *
     * Gathered here rather than off the log, for docs/audio.md's reason: the
     * feed is prose written for a reader, and a sound has to be attached to the
     * frame the thing happened in.
     */
    const seen = new Set();
    for (const c of state.customers ?? []) {
      if (!c.stole) continue;
      seen.add(c.id);
      if (this.thieves.has(c.id)) continue;
      sfx.play('error', c, { every: 0, rate: 0.7 });
      onAlarm?.(c);
    }
    // Forgotten only once they are off the map, or a thief who walks behind a
    // shelf for a frame comes back as a fresh alarm.
    for (const id of this.thieves) if (!seen.has(id)) this.thieves.delete(id);
    for (const id of seen) this.thieves.add(id);

    // A crate landing used to be diffed off `deliveries` here, on the argument
    // that one entity deserves one noise — which is a claim about the OBJECT
    // where a sound is a claim about who did something. `dropGoods` is the
    // single place a crate is made and most of its callers are nobody: a
    // stocker stowing an armful, a packer boxing a bay, a loader mounding boxes
    // off the end of a run, a sorter splitting an overfull one. On a shop with
    // belts in it that is a thud every few ticks, for ever, none of which is
    // news and none of which you asked for — the slot machine the caps in
    // docs/audio.md exist to prevent, arriving through the one event that
    // scales with how automated the shop is.
    //
    // So the crate thud is yours: `ON_FINISH` fires it off the shop's own count
    // of actions YOU finished, which is the same channel the shelving and
    // harvesting noises come from and cannot be triggered by anybody else's
    // work. The van keeps its two reverse beeps, which is what actually
    // announces a delivery — the thumps were never how you knew it had come.

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

    // What you just did — the shop's own count of jobs that fired, rather than
    // a guess off how far the ring got. See the note where `DONE_AT` used to be
    // for why that guess was worse than no sound at all.
    const acted = me?.acted ?? null;
    if (acted && acted.n > this.acts) {
      const id = ON_FINISH[acted.kind];
      if (id) sfx.play(id, me);
    }

    // Hands, for everything that fills or empties them without an action —
    // picking a crate off a pile, a shelf board tapped for one unit.
    const carry = me?.carry?.item_id ?? null;
    if (carry && carry !== this.carry && !this.action) sfx.play('pickup', me);
    const haul = me?.haul ? 'y' : null;
    if (haul && !this.haul) sfx.play('crate', me);

    this.drops = drops;
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
    // No `acted` at all is the shop saying zero, which is what a player who has
    // just joined has done. It is in memory on the player record and never on
    // the save, so arriving never inherits somebody else's tally.
    this.acts = me?.acted?.n ?? 0;
    this.action = me?.action?.kind ?? null;
    this.carry = me?.carry?.item_id ?? null;
    this.haul = me?.haul ? 'y' : null;
  }
}

export const events = new Events();
