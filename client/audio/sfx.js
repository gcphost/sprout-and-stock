/**
 * ONE-SHOTS — the noise a thing makes when it happens.
 *
 * This is the half of docs/audio.md that was always the point: **a sound is the
 * channel that works while you are looking at a panel.** A noise for something
 * you were already watching is decoration; a noise for something that happened
 * behind you is information. Everything in here is attached to a moment.
 *
 * The caps are not tuning, they are the feature. A shop with twenty shoppers,
 * four staff, three appliances and a van arriving generates far more events
 * than anybody wants to hear, and without the four rules below what you get is
 * a slot machine:
 *
 * - **Six voices.** A seventh steals the oldest. Not "queue it" — a sound
 *   played late is worse than one not played, because it is attached to the
 *   wrong moment.
 * - **Dedupe by id.** Four sales in one tick is one till noise.
 * - **Far away is quiet, and very far away is silent.** Measured from your own
 *   feet, not the camera: the camera can be anywhere while you build, and a
 *   shop that got louder because you panned would be reporting the view.
 * - **Pan by where it is relative to you.** Not three.js `PositionalAudio` —
 *   that wants a listener graph and an orientation, and two numbers off a world
 *   position do the whole job here.
 *
 * The rule underneath all four: **a sound is a report about something, so two
 * sounds reporting the same thing is one sound.**
 */

import { mix } from './mix.js';
import { SOUNDS, soundById } from './manifest.js';
import { hash01 } from '../../shared/hash.js';

/** How many may sound at once. */
const VOICES = 6;

/** Two of the same inside this many ms is one of them. */
const DEDUPE_MS = 80;

/** Full volume within this many tiles of you, silent past the second. */
const NEAR = 6;
const FAR = 22;

/** How wide the stereo picture is. Past about 0.7 it starts to feel gimmicky. */
const SPREAD = 0.6;

/**
 * The fade on either end of a sliced sound.
 *
 * Not optional. A slice starts and stops at whatever the waveform happened to
 * be doing, which is almost never zero — and a jump from a non-zero sample to
 * silence is a step, which is a transient with energy right across the
 * spectrum. You hear it as a click on both ends, and it reads as the file being
 * corrupt rather than as the edit being blunt. 8ms is inaudible as a fade and
 * comfortably longer than the step.
 */
const SLICE_FADE = 0.008;

/**
 * How many loops may be open at once, and it is the same call `lights.js` makes
 * about the ninth lamp — made here before there is a catalogue of humming
 * fixtures to trip over it.
 *
 * A loop is not a sound that happens, it is a decoder that stays running, so
 * this caps a cost rather than a racket: a shop with nine appliances and six
 * freezers would otherwise hold fifteen buffer sources open for a room you can
 * only hear four things in anyway. Nearest wins, which is the same answer the
 * lamps give and for the same reason — what is near you is what the room sounds
 * like.
 */
const LOOPS = 4;

/**
 * How long a loop takes to come up and go down, in seconds.
 *
 * Longer than `SLICE_FADE` by a lot, and not for the same reason: that one is
 * about a click at a splice, this is about a machine that STARTS. A hum
 * appearing instantly reads as an audio glitch even when the waveform is
 * perfectly zero-crossed — you notice the moment rather than the machine — and
 * the moments this fires on are ones nothing on screen marks: walking into
 * earshot, a batch beginning, the shop re-flowing under you.
 */
const LOOP_FADE = 0.35;

class Sfx {
  constructor() {
    this.buffers = new Map();
    this.playing = [];
    this.lastAt = new Map();
    this.state = 'cold';
    /** Where you are, for distance and pan. Set by `listenAt`. */
    this.me = null;
    /**
     * The open loops, by the key their caller gave them — a TILE, in practice,
     * for the reason `events.layout` keys tiers by one: a fixture that is turned
     * or upgraded comes back with a new id on the same square, so a loop keyed
     * by id would stop and restart on every re-flow. And a player who is
     * *building* re-flows on every wall segment of a drag, which is precisely
     * docs/audio.md's "a layout re-flow must not restart the ambience", said
     * about the noise a fridge makes.
     */
    this.loops = new Map();
  }

  /**
   * Fetch and decode the lot, once, after arming.
   *
   * All ten together — they total under 150KB, so a lazy per-sound load would
   * trade a trivial saving for the one thing that actually matters here, which
   * is that the *first* till of the session is not silent while it fetches.
   */
  async load() {
    if (this.state !== 'cold') return;
    this.state = 'loading';
    const ctx = mix.ctx;
    await Promise.all(SOUNDS.map(async (s) => {
      try {
        const bytes = await (await fetch(s.url)).arrayBuffer();
        // Callback form as well as the promise: older Safari's
        // `decodeAudioData` resolves nothing without it.
        const buf = await new Promise((ok, no) => { ctx.decodeAudioData(bytes, ok, no); });
        this.buffers.set(s.id, buf);
      } catch (err) {
        // Silence is the correct failure for one sound, the same way it is for
        // all of them. Everything in this game works without audio.
        console.warn(`[audio] ${s.id} unavailable:`, err);
      }
    }));
    this.state = 'ready';
  }

  /** Where the player is, in tiles. Anything without a position plays flat. */
  listenAt(x, z) { this.me = { x, z }; }

  /**
   * How loud and how wide something at `at` is, or null for out of earshot.
   *
   * One answer for one-shots and loops both, which is the point of it being a
   * function: they are the same question about the same room, and two copies of
   * this arithmetic would be two shops — one where the farm is audible and one
   * where it is not, differing by which noise you happened to make.
   *
   * Measured from YOUR FEET rather than the camera, which docs/audio.md is
   * explicit about: the camera can be anywhere while you build, and a shop that
   * got louder because you panned would be reporting the view rather than the
   * shop.
   */
  place(at) {
    if (!at || !this.me) return { scale: 1, pan: 0, d: 0 };
    const dx = at.x - this.me.x;
    const dz = at.z - this.me.z;
    const d = Math.hypot(dx, dz);
    if (d > FAR) return null;
    return {
      d,
      scale: 1 - Math.max(0, (d - NEAR) / (FAR - NEAR)),
      // Both axes, because this camera looks down a diagonal: a thing directly
      // north of you is up-screen and slightly to one side, and panning on x
      // alone puts half the shop dead centre.
      pan: Math.max(-1, Math.min(1, ((dx - dz) / (2 * NEAR)) * SPREAD)),
    };
  }

  /**
   * THE LOOPS — everything that is on for as long as it is true, rather than
   * happening once.
   *
   * A whole-list call rather than `startLoop`/`stopLoop` pairs, and that is the
   * one design decision in here worth the paragraph. The truth about which
   * machines are running arrives as a **snapshot** — a picture of now, ten times
   * a second — so the caller can always say what SHOULD be sounding and can
   * never reliably say what just changed. Hooks would need a matching stop for
   * every start, and every dropped frame, closed tab, re-flow or fixture sold
   * out from under one is a hum left running in an empty shop with nothing left
   * that knows how to stop it. Reconciling a list cannot leak: anything not in
   * it is not playing, by construction.
   *
   * `wanted` is `[{ key, id, at }]`. `key` is the caller's idea of identity and
   * wants to be a TILE — see the note on `this.loops`.
   *
   * Out of earshot is STOPPED rather than turned down, which docs/audio.md
   * flags ahead of time: a gain of exactly 0 is not the same as a stopped loop,
   * because a silent source still costs a decoder and still gets scheduled. The
   * corollary is that walking away from a fridge and back is a real stop and a
   * real start, which is what `LOOP_FADE` is for.
   */
  setLoops(wanted = []) {
    // Not armed, not loaded, or the world is stopped: nothing may be holding a
    // voice open. The empty call is the same path as an ordinary one, so there
    // is no second way for a loop to end.
    if (!mix.armed || this.state !== 'ready') wanted = [];

    const ctx = mix.ctx;
    const now = ctx?.currentTime ?? 0;

    // Score first, then cap: nearest wins, so the four you can hear are the
    // four nearest you rather than the four that happen to be first in the
    // layout — which is a list ordered by when they were built.
    const scored = [];
    for (const w of wanted) {
      const spec = soundById(w.id);
      const buf = this.buffers.get(w.id);
      if (!spec || !buf) continue;
      const place = this.place(w.at);
      if (!place) continue;
      scored.push({ ...w, spec, buf, place });
    }
    scored.sort((a, b) => a.place.d - b.place.d);
    const keep = new Map(scored.slice(0, LOOPS).map((w) => [w.key, w]));

    for (const [key, rec] of [...this.loops]) {
      // A tile whose piece CHANGED sound is a stop and a start rather than a
      // swap: the buffer is the thing playing, and there is no way to change it
      // under a running source.
      if (!keep.has(key) || keep.get(key).id !== rec.id) this.endLoop(key, rec);
    }

    for (const [key, w] of keep) {
      const rec = this.loops.get(key) ?? this.startLoop(key, w);
      if (!rec) continue;
      // Ramped rather than set, because this runs on every snapshot and you are
      // usually walking: a gain stepped ten times a second is a zipper down the
      // whole approach, which is the one artefact that sounds like a broken
      // game rather than a quiet one.
      const level = w.spec.gain * w.place.scale;
      rec.gain.gain.setTargetAtTime(level, now, 0.08);
      rec.pan?.pan.setTargetAtTime(w.place.pan, now, 0.08);
    }
  }

  /** Open one. Fades up from silence; the caller sets the level it fades to. */
  startLoop(key, w) {
    const ctx = mix.ctx;
    if (!ctx) return null;
    const src = ctx.createBufferSource();
    src.buffer = w.buf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0;

    let tail = g;
    let pan = null;
    if (ctx.createStereoPanner) {
      pan = ctx.createStereoPanner();
      g.connect(pan);
      tail = pan;
    }
    src.connect(g);
    tail.connect(mix.out('sfx'));

    // Each one starts somewhere else in the file, by a hash of where it stands.
    // Two identical machines started together are not two machines — they are
    // one machine at twice the level, plus comb filtering wherever the room
    // puts them out of step, and a row of four reads as a fault. A hash rather
    // than a draw for the reason the hires' pitch is one: the same fridge has to
    // sound the same after a reload, and nothing cosmetic may touch a stream.
    try { src.start(0, hash01(key) * w.buf.duration); } catch { return null; }
    const rec = { id: w.id, src, gain: g, pan };
    this.loops.set(key, rec);
    return rec;
  }

  /** Close one, and take it off the books first so nothing can find it again. */
  endLoop(key, rec) {
    this.loops.delete(key);
    const ctx = mix.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    try {
      rec.gain.gain.cancelScheduledValues(t);
      // `setTargetAtTime` leaves the parameter on a curve rather than at a
      // value, so the ramp has to be anchored at where it actually IS — read
      // through `value`, which is the current computed one — or the fade starts
      // from wherever the last target was aimed and jumps.
      rec.gain.gain.setValueAtTime(rec.gain.gain.value, t);
      rec.gain.gain.linearRampToValueAtTime(0, t + LOOP_FADE);
      // Stopped for real at the end of the fade: a source left running at zero
      // is the decoder this cap exists to bound.
      rec.src.stop(t + LOOP_FADE);
    } catch { /* already stopped */ }
  }

  /**
   * Play one, optionally at a place in the world.
   *
   * Returns nothing and throws nothing. Every caller is a game event that has
   * already happened, so there is no failure here worth propagating — the shop
   * does not care whether it was audible.
   */
  play(id, at = null, { gain = 1, rate = 1, every = DEDUPE_MS, dur = null } = {}) {
    if (!mix.armed || this.state !== 'ready') return;
    const buf = this.buffers.get(id);
    const spec = soundById(id);
    if (!buf || !spec) return;

    const ctx = mix.ctx;
    const now = ctx.currentTime;

    // Dedupe. Keyed by id rather than by id-and-place: four tills ringing in
    // one tick is still one thing happening to the shop, and hearing it four
    // times says the shop is four times as busy as it is.
    // `every` is the same rule with a longer arm, for a sound that several
    // things in the shop can cause at once — five hires all picking up a job on
    // the same tick is five chirps 80ms apart, which is not a shop full of
    // robots, it is a fault.
    const last = this.lastAt.get(id) ?? -Infinity;
    if ((now - last) * 1000 < every) return;
    this.lastAt.set(id, now);

    // Distance and pan, if it happened somewhere.
    const place = this.place(at);
    if (!place) return;
    const level = spec.gain * gain * place.scale;
    const { pan } = place;
    if (level <= 0.001) return;

    // Steal the oldest rather than refuse the newest — the newest is the one
    // attached to what just happened.
    while (this.playing.length >= VOICES) {
      const old = this.playing.shift();
      try { old.stop(); } catch { /* already done */ }
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Pitch, which for the hires is identity: `rate` is a hash of who it is, so
    // the same robot always sounds like itself and no two quite match. The same
    // trick the client already uses for a hire's breathing phase, and it costs
    // no draw on `this.rng` — see CLAUDE.md on why a cosmetic per-person value
    // must never come out of the measured stream.
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = level;

    // A slice: `dur` seconds from somewhere random in the file.
    //
    // This is how one five-second recording becomes a dozen different noises.
    // A machine burbling is not a *sound*, it is a supply of them — the useful
    // unit is a fifth of a second of it, and which fifth is the variety. Random
    // per play rather than hashed per hire, deliberately: the hire's identity
    // is already carried by `rate`, so a fixed offset as well would make every
    // chirp from one robot identical, which is a stuck record rather than a
    // character.
    //
    // `Math.random` is fine here in a way it is not in `server/` — nothing
    // about which fifth of a burble you heard can reach the save, the balance
    // or another player.
    //
    // `dur` is how long you HEAR it, not how much tape it eats. Those differ by
    // `rate`, and the difference is the whole reason this is spelled out: pitch
    // a chirp down to two thirds speed and a "0.3 second" slice measured off
    // the buffer plays for 0.45 — so every time the pitch was tuned the length
    // moved with it, and the two knobs fought. Taking `dur * rate` off the tape
    // makes the number mean what it says at any pitch.
    let offset = 0;
    let span = 0;
    if (dur != null) {
      span = Math.min(dur * rate, buf.duration);
      offset = Math.random() * Math.max(0, buf.duration - span);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(level, now + SLICE_FADE);
      g.gain.setValueAtTime(level, now + Math.max(SLICE_FADE, dur - SLICE_FADE));
      g.gain.linearRampToValueAtTime(0, now + dur);
    }

    let tail = g;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      tail = p;
    }
    src.connect(g);
    tail.connect(mix.out('sfx'));

    this.playing.push(src);
    src.onended = () => {
      const i = this.playing.indexOf(src);
      if (i >= 0) this.playing.splice(i, 1);
    };
    if (dur != null) src.start(now, offset, span);
    else src.start();
  }
}

export const sfx = new Sfx();
