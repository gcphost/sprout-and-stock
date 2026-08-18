/**
 * THE MIXER — the context, the buses, and one knob per bus.
 *
 * Nothing in here makes a sound. It owns the graph everything else plugs into,
 * and the reason it is its own file is that the graph has to exist before any
 * of it can, and has to survive all of it going away.
 *
 * See docs/audio.md.
 *
 *     music ─┐
 *            ├─→ master ─→ destination
 *     sfx   ─┘
 *
 * Two buses because there are two sliders. A player who wants the shop noises
 * and not the music has asked a question one gain node cannot answer, and
 * bolting a second one on later means every source built against the first is
 * plugged into the wrong thing.
 *
 * There is deliberately no third bus for ambience. There was one, it held a
 * crowd bed that swelled with the shop, and it was cut — see docs/audio.md,
 * "What was tried and cut". A bus with nothing on it is a knob that turns
 * nothing, which is the same trap as a tier that changes no number.
 */

const BUSES = ['music', 'sfx'];

const STORE = 'sns-audio';

const DEFAULTS = { master: 0.7, music: 0.45, sfx: 0.9, muted: false };

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * How long a volume change takes.
 *
 * Not zero. A gain set instantaneously clicks — the waveform steps, and a step
 * is a transient with energy right across the spectrum, audible as a tick even
 * going *down*. 30ms is below anything anybody would call a fade and far above
 * the one that clicks.
 */
const KNOB_RAMP = 0.03;

class Mix {
  constructor() {
    /** Null until the first real input — see `arm`. */
    this.ctx = null;
    this.master = null;
    this.bus = {};
    this.pref = { ...DEFAULTS };
    this.armed = false;
    this.waiting = [];
  }

  /**
   * Read the volumes back.
   *
   * A volume is about the person and the room they are sitting in, not about
   * the shop, so it belongs to the browser rather than to the save: two people
   * playing one world down the tunnel must not share a knob, or one of them
   * turning the music down turns it down for somebody in a different house.
   * `panel-drag.js` keeps a panel's position the same way and for the same
   * reason.
   *
   * The try/catch is not decoration — storage can be blocked outright, and a
   * browser that refuses to remember a preference should lose the preference,
   * not the audio.
   */
  load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}');
      for (const k of ['master', ...BUSES]) {
        if (typeof saved[k] === 'number') this.pref[k] = clamp01(saved[k]);
      }
      if (typeof saved.muted === 'boolean') this.pref.muted = saved.muted;
    } catch { /* not worth a toast */ }
  }

  save() {
    try { localStorage.setItem(STORE, JSON.stringify(this.pref)); } catch { /* ditto */ }
  }

  /**
   * Build the graph and start the clock. Safe to call on every input forever.
   *
   * A browser will not run an `AudioContext` until the user has clicked
   * something, so this cannot happen at import time. Miss that and the game has
   * sound in the dev tab — where you have clicked a hundred times — and is
   * silent for every fresh player, which reads as the audio being broken rather
   * than as it being asleep.
   *
   * The preferences are read *before* the context is resumed, deliberately. A
   * player who muted last session and then clicked to arm must not get a frame
   * of full-volume audio in between, which is what reading them in whatever
   * runs next would give them.
   */
  arm() {
    if (this.armed) return this.ctx;
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return null;

    this.load();
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.pref.muted ? 0 : this.pref.master;
    this.master.connect(this.ctx.destination);

    for (const name of BUSES) {
      const g = this.ctx.createGain();
      g.gain.value = this.pref[name];
      g.connect(this.master);
      this.bus[name] = g;
    }

    this.armed = true;
    this.ctx.resume?.();
    // Anything that wanted to start before there was a context to start in.
    const waiting = this.waiting;
    this.waiting = [];
    for (const fn of waiting) fn();
    return this.ctx;
  }

  /** Run `fn` once there is a graph — now, if there already is one. */
  onArmed(fn) {
    if (this.armed) fn();
    else this.waiting.push(fn);
  }

  /** The node a source should plug into. Null before arming. */
  out(name) { return this.bus[name] ?? null; }

  volume(name) { return this.pref[name] ?? 0; }

  setVolume(name, v) {
    const next = clamp01(v);
    if (this.pref[name] === next) return;
    this.pref[name] = next;
    this.save();
    if (!this.armed) return;
    const node = name === 'master' ? this.master : this.bus[name];
    // Master obeys the mute; a bus does not, so unmuting comes back to whatever
    // the mix was rather than to whatever the last slider touched was.
    const target = name === 'master' && this.pref.muted ? 0 : next;
    node?.gain.setTargetAtTime(target, this.ctx.currentTime, KNOB_RAMP);
  }

  get muted() { return this.pref.muted; }

  setMuted(on) {
    this.pref.muted = !!on;
    this.save();
    if (!this.armed) return;
    this.master.gain.setTargetAtTime(
      this.pref.muted ? 0 : this.pref.master, this.ctx.currentTime, KNOB_RAMP,
    );
  }

  /**
   * Everything the Sound tab reads, as one string.
   *
   * Same shape a section's `live` wants: the panel repaints when this changes
   * and never otherwise, and the honest test of a switch is that it moved.
   */
  signature() {
    return `${this.pref.muted ? 'm' : '-'}|${this.pref.master}|${
      BUSES.map((b) => this.pref[b]).join(',')}|${this.armed ? 'a' : '-'}`;
  }
}

export const mix = new Mix();

/**
 * The preferences before there is a context to apply them to.
 *
 * The Sound tab is reachable before anything has armed, and a mute switch that
 * says "On" while the mixer has never heard of it is the panel lying. So `load`
 * runs at import and every setter writes through whether or not there is a
 * graph; `arm` reads the same store again on the way up, which is what makes
 * the ordering above true.
 */
mix.load();
