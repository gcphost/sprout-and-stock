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

class Sfx {
  constructor() {
    this.buffers = new Map();
    this.playing = [];
    this.lastAt = new Map();
    this.state = 'cold';
    /** Where you are, for distance and pan. Set by `listenAt`. */
    this.me = null;
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
    let level = spec.gain * gain;
    let pan = 0;
    if (at && this.me) {
      const dx = at.x - this.me.x;
      const dz = at.z - this.me.z;
      const d = Math.hypot(dx, dz);
      if (d > FAR) return;
      level *= 1 - Math.max(0, (d - NEAR) / (FAR - NEAR));
      // Both axes, because this camera looks down a diagonal: a thing directly
      // north of you is up-screen and slightly to one side, and panning on x
      // alone puts half the shop dead centre.
      pan = Math.max(-1, Math.min(1, ((dx - dz) / (2 * NEAR)) * SPREAD));
    }
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
