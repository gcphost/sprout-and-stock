/**
 * MUSIC — a lofi playlist on its own bus.
 *
 * Its own bus and its own knob because it is the one sound in the game somebody
 * will want off while keeping everything else. That is the whole reason
 * `mix.js` has more than one gain node.
 *
 * Three decisions worth knowing:
 *
 * **It walks the list, it does not shuffle.** A shuffle that can repeat a track
 * reads as the playlist being broken, and one that cannot repeat is a walk with
 * extra steps. The order is the order in the manifest.
 *
 * **Each track loops until it has had a proper turn.** These are game tracks —
 * 40 seconds to two minutes, written to repeat — so playing one through once
 * and moving on is not a playlist, it is a demo reel: the shortest is over
 * before you have finished stocking a shelf, and what it reads as is samples
 * rather than songs. `SET` is roughly how long one gets before the next, and
 * the count is a whole number of passes so a track always ends where it was
 * written to end rather than being faded out mid-phrase.
 *
 * Rounded to the NEAREST pass, not up. Up is the obvious choice and it is badly
 * wrong at the top of the range: a 1:54 track against a two-minute target is
 * six seconds short, so rounding up plays it twice and it holds the floor for
 * 3:48 — the longest tracks get the longest turns, which is exactly backwards.
 * To the nearest, everything lands between 1:54 and 2:17.
 *
 * **Tracks cross over each other, they do not queue.** The next one is decoded
 * ahead of time and comes up underneath the one going out, over ten seconds.
 * There is no silence between them at all — the handover is the thing you are
 * meant not to notice.
 *
 * **One track is decoded at a time.** These are two to four megabytes each and
 * decoding them all up front would put twenty seconds of PCM in memory for the
 * three nobody is listening to yet.
 */

import { mix } from './mix.js';
import { TRACKS } from './manifest.js';

/**
 * How long two tracks overlap, in seconds.
 *
 * Long, on purpose. A short crossfade is a *transition* — you hear it happen
 * and you hear two pieces of music briefly disagreeing about the key. Ten
 * seconds is slow enough that neither track is ever loud while the other is,
 * so what you notice is that the music is different now, not that it changed.
 */
const XFADE = 10;

/**
 * How long one track holds the floor, in seconds, before the next.
 *
 * Rounded up to whole passes, so the real figure is this or a bit more — a
 * 40-second loop gets six passes, a two-minute one gets two.
 */
const SET = 120;

/** How long the last track takes to go when you stop the playlist outright. */
const FADE = 3;

/**
 * How fast the music goes when the world stops, in seconds.
 *
 * Short, because a pause has to feel immediate — a three-second fade means you
 * press pause and the game is still playing music at you, which reads as the
 * button not having worked. Not zero, because a gain cut to nothing in one
 * sample clicks.
 */
const PAUSE_FADE = 0.25;

/**
 * An equal-power fade, as a curve.
 *
 * Two linear ramps in opposite directions do NOT sum to constant loudness —
 * halfway through both sit at 0.5, and two uncorrelated signals at half gain
 * are quieter than either at full. You hear it as the music sagging in the
 * middle of every handover, which reads as a bug in the volume rather than as
 * a crossfade. Sine and cosine hold the sum flat, which is the whole trick.
 */
function powerCurve(peak, rising, steps = 64) {
  const a = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const t = (i / (steps - 1)) * (Math.PI / 2);
    a[i] = peak * (rising ? Math.sin(t) : Math.cos(t));
  }
  return a;
}

/** How loud, before the Music slider. Deliberately background. */
const LEVEL = 0.55;

/** Where the radio remembers itself. Same store the volumes use — see `mix.js`. */
const MEM = 'sns-radio';

/**
 * How often the position is written down, in ms.
 *
 * A reload can only ever come back to the last thing written, so this is the
 * worst the resume can be out by. Three seconds is imperceptible in a piece of
 * background music and is a `localStorage` write every three seconds rather
 * than every frame, which is the trade worth making — `pagehide` catches the
 * ordinary case exactly, and this is only the backstop for a tab that was
 * killed rather than closed.
 */
const REMEMBER_EVERY = 3000;

class Music {
  constructor() {
    this.at = -1;
    this.node = null;
    this.gain = null;
    this.timer = null;
    this.on = false;
    /**
     * Why it is stopped, not just whether.
     *
     * Three things can stop the music and they must not overwrite each other:
     * the world being paused, you pressing pause on the radio, and the front
     * door's own mute. One boolean gets this wrong in a way you would hit within
     * a minute — pause the game while the radio is off, unpause it, and the
     * music comes back on by itself.
     *
     * `menu` is the newest and the only one that is about a SCREEN rather than
     * about a decision: it is set while the shop list is up and released when it
     * goes, so quietening the front door cannot follow you into a shop. See
     * `Menu.play`.
     */
    this.held = { game: false, user: false, menu: false };
    this.paused = false;
    /** What is loaded, so a resume does not have to fetch and decode again. */
    this.buf = null;
    /** `ctx.currentTime` this track started at, and where in it that was. */
    this.began = 0;
    this.from = 0;
    /** Seconds of this track's turn still to run when it was paused. */
    this.left = 0;
    /** Where the next track should start, for a resume. Cleared once used. */
    this.seek = 0;
    /** How much of a remembered turn was left. Null once spent. */
    this.resumeLeft = null;
    /** The track on the radio, playing or not — what the LCD says. */
    this.current = null;
    /**
     * WHICH ATTEMPT TO PUT MUSIC ON IS THE LIVE ONE.
     *
     * `next` is async — it fetches and decodes a megabyte of ogg — so between
     * being asked for a track and starting one, anything can happen: the world
     * can pause, you can skip twice, the radio can be switched off. Every one of
     * those is a decision made about a track that has not begun, and the old
     * code only re-checked two of them (`on`, `armed`), which is how you get two
     * tracks at once out of a game that was PAUSED:
     *
     *   the tab arms on your click, `next` starts decoding, the first snapshot
     *   arrives saying the world is paused — and the pause finds `this.node`
     *   null, because nothing is playing yet, so it stops nothing and returns.
     *   The decode then lands, ignores the pause, and starts playing. Music,
     *   under a stopped shop. Then you press play: the world un-pauses, the
     *   resume finds `this.buf` set, builds a SECOND source and assigns it over
     *   `this.node` — and the first one is still going, with nothing left in the
     *   object that points at it. Nothing can ever stop it now.
     *
     * A counter is the fix rather than one more flag, because the question is
     * not "is it paused" but "is this still the request the radio wants" — and
     * that is the same question for a pause, a skip, a mute and a stop. Bumped
     * by everything that decides what should be playing; an attempt whose number
     * is stale drops what it decoded on the floor.
     */
    this.gen = 0;
    /**
     * Hold this track instead of moving on.
     *
     * Costs nothing to implement and that is the point worth noting: the source
     * is already `loop = true`, so repeat is not a re-trigger, it is simply
     * declining to schedule the handover. Which makes it the only seamless
     * transition in here — a repeated track has no crossfade at all, because
     * nothing ever stops.
     */
    this.repeat = false;
  }

  /** How far into the current track we are, in seconds. */
  position() {
    if (!this.buf) return 0;
    const played = this.node ? mix.ctx.currentTime - this.began : 0;
    return (this.from + played) % this.buf.duration;
  }

  /**
   * Write down what is on and how far in.
   *
   * `localStorage`, not the save, for exactly the reason the volumes are —
   * this is about the person and the browser they are sitting at, and two
   * people down the tunnel would otherwise fight over one radio.
   *
   * The **track id** is stored rather than its index. An index is a promise
   * about the shape of `TRACKS`, and that list grows every time somebody finds
   * another good one — so a reload after a playlist edit would come back to
   * whatever had shuffled into slot 7, which is the kind of bug that looks like
   * the resume not working at all.
   */
  remember() {
    if (!this.on) return;
    try {
      localStorage.setItem(MEM, JSON.stringify({
        id: this.current?.id ?? null,
        pos: this.position(),
        left: Math.max(0, this.left - (this.node ? mix.ctx.currentTime - this.began : 0)),
        off: this.held.user,
        rep: this.repeat,
      }));
    } catch { /* storage blocked — lose the position, not the music */ }
  }

  recall() {
    try { return JSON.parse(localStorage.getItem(MEM) ?? 'null'); } catch { return null; }
  }

  /**
   * Stop and restart the music with the world.
   *
   * A real pause, not a mute: the track resumes from the bar it stopped on. A
   * duck to zero would be simpler and is the wrong thing — the music would go
   * on running behind the pause, so a minute spent in a menu would cost you a
   * minute of the track and you would come back somewhere you had never heard.
   *
   * It is the music alone rather than `ctx.suspend()`, which would take the
   * whole graph with it. You can still open menus while the world is stopped,
   * and a UI that fell silent as soon as you paused would read as the game
   * having frozen rather than as it waiting for you.
   *
   * `BufferSource` has no pause, so this is a stop and a fresh source at an
   * offset — which is also why the buffer is kept: a resume that re-fetched
   * would be silent for as long as the decode took.
   */
  setPaused(on) { this.hold('game', on); }

  /** The radio's own play/pause. Independent of the world's. */
  togglePlay() { this.hold('user', !this.held.user); }

  toggleRepeat() {
    this.repeat = !this.repeat;
    this.remember();
    clearTimeout(this.timer);
    this.timer = null;
    if (this.repeat || !this.node) return;
    // Coming off repeat, give back whatever was left of this track's turn. It
    // may well be none — you can sit on repeat far longer than a turn — in
    // which case the next track is due now rather than overdue.
    const spent = mix.ctx.currentTime - this.began;
    this.timer = setTimeout(() => this.next(), Math.max(0, this.left - spent) * 1000);
  }

  /**
   * Is the radio itself running — ignoring whether the world is stopped.
   *
   * Spelled `live` rather than `playing`, because `playing` is already the
   * track record on this object and a getter of the same name is not a clash
   * you find by reading: the field assignment silently becomes a write to an
   * accessor with no setter, which in a module (strict mode, always) throws
   * TypeError at the moment a track starts — so the music works until the
   * first handover and then the playlist dies.
   */
  get live() { return !this.held.user; }

  /**
   * Should the radio be stopped right now — for ANY reason.
   *
   * The one derivation, and it is a getter rather than three copies of
   * `a || b` because there were three copies and each named a different pair.
   * `hold` asked game-or-user, `start` asked user alone and `go` asked game
   * alone, all correct while there were exactly two holders and all three
   * silently wrong the moment there was a third. What that presents as is a
   * mute button that works until you touch the transport, and then does not —
   * a state that disagrees with itself with no way to see which half is stale.
   *
   * Same rule CLAUDE.md states about kinds: anything that enumerates the cases
   * is a place the next one dies quietly.
   */
  get stopped() { return Object.values(this.held).some(Boolean); }

  hold(who, on) {
    this.held[who] = !!on;
    const want = this.stopped;
    if (!this.on || !mix.armed || want === this.paused) return;
    this.paused = want;
    const on_ = want;

    if (on_) {
      clearTimeout(this.timer);
      this.timer = null;
      // Anything still decoding was asked for by the shop as it was a moment
      // ago, and the shop has stopped. Without this the track lands *after* the
      // pause and plays through it.
      this.gen++;
      if (!this.node) return;
      const played = mix.ctx.currentTime - this.began;
      this.left = Math.max(0, this.left - played);
      // Where in the track we had got to. Modulo its length because it loops —
      // a two-minute turn on a forty-second track is somewhere in the third lap.
      this.from = (this.from + played) % (this.buf?.duration || 1);
      this.fadeOutAndStop(this.node, this.gain, PAUSE_FADE);
      this.node = null;
      this.gain = null;
      return;
    }
    if (this.buf) this.resume();
    else this.next();
  }

  /** Put the paused track back on, from where it stopped. */
  resume() {
    const ctx = mix.ctx;
    const now = ctx.currentTime;
    // Belt and braces, and the braces are the ones that failed: this claims
    // `this.node`, so anything already in it would go on playing with nothing
    // left pointing at it — unstoppable, unskippable, and audible over the top
    // of whatever comes next. `this.gen` above should mean there is never
    // anything here; this is what makes that a bug rather than a doubled track.
    this.gen++;
    this.stopNow();
    const src = this.source(this.buf, this.current);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(mix.out('music'));
    src.start(now, this.from);
    gain.gain.setValueCurveAtTime(powerCurve(LEVEL, true), now, PAUSE_FADE);

    this.node = src;
    this.gain = gain;
    this.began = now;
    if (!this.repeat) {
      this.timer = setTimeout(() => this.next(), Math.max(0, this.left) * 1000);
    }
  }

  /** A looping source for one track, with its authored loop points. */
  source(buf, track) {
    const src = mix.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    if (track?.loopFrom != null) src.loopStart = track.loopFrom;
    if (track?.loopTo != null) src.loopEnd = track.loopTo;
    return src;
  }

  /**
   * Start the playlist, and keep it going.
   *
   * Safe to call more than once — the second call is a no-op rather than a
   * second playlist, which is the bug that turns a reconnect into two tracks at
   * the same time.
   */
  start() {
    if (this.on) return;
    this.on = true;

    const was = this.recall();
    const found = was?.id ? TRACKS.findIndex((t) => t.id === was.id) : -1;
    if (found >= 0) {
      // `next` increments before it plays, so step back one to land on it.
      this.at = found - 1;
      this.seek = was.pos ?? 0;
      this.resumeLeft = was.left ?? null;
      this.held.user = !!was.off;
      this.paused = this.stopped;
      // So the screen says what is cued up even when the radio came back off.
      // Otherwise reloading with the music paused shows "Shop radio", and the
      // track you had chosen looks lost until you press play.
      this.current = TRACKS[found];
      this.repeat = !!was.rep;
    }

    addEventListener('pagehide', () => this.remember());
    // A tab that is killed rather than closed never fires `pagehide`, which is
    // most of them — see `REMEMBER_EVERY`.
    setInterval(() => this.remember(), REMEMBER_EVERY);

    mix.onArmed(() => { if (this.on && !this.paused) this.next(); });
  }

  stop() {
    this.on = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.stopNow();
  }

  /**
   * Take a track out over `secs`, and forget it.
   *
   * The node is handed in rather than read off `this`, because during a
   * crossfade the outgoing track is no longer the current one — `next` has
   * already claimed that slot for the incoming one. Reading `this.node` here
   * was the version that faded out the track it had just started.
   */
  fadeOutAndStop(node, gain, secs) {
    if (!node) return;
    const now = mix.ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueCurveAtTime(powerCurve(gain.gain.value, false), now, secs);
    try { node.stop(now + secs + 0.05); } catch { /* already stopped */ }
  }

  stopNow() {
    this.fadeOutAndStop(this.node, this.gain, FADE);
    this.node = null;
    this.gain = null;
  }

  /**
   * Skip, forwards or back.
   *
   * Crossfades like an ordinary change of track rather than cutting, which is
   * the one decision here worth stating: a ten-second handover on a button you
   * pressed feels slow, and cutting on a *scheduled* change would be jarring.
   * Same fade both ways is the cheaper mistake, and it keeps one code path.
   */
  go(delta) {
    if (!this.on || !mix.armed) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.at = (this.at + delta - 1 + TRACKS.length * 2) % TRACKS.length;
    // Pressing a transport button is asking for music, so it un-pauses the
    // radio — but never the world.
    this.held.user = false;
    this.paused = this.stopped;
    if (!this.paused) this.next();
  }

  /** Jump straight to one track by id. Used by the Credits tab. */
  playById(id) {
    const i = TRACKS.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.at = i - 1;
    this.seek = 0;
    this.resumeLeft = null;
    this.go(1);
  }

  async next() {
    if (!this.on || !mix.armed || this.paused) return;
    const gen = ++this.gen;
    this.at = (this.at + 1) % TRACKS.length;
    const track = TRACKS[this.at];

    let buf;
    try {
      const bytes = await (await fetch(track.url)).arrayBuffer();
      buf = await new Promise((ok, no) => { mix.ctx.decodeAudioData(bytes, ok, no); });
    } catch (err) {
      console.warn(`[audio] ${track.id} unavailable:`, err);
      // Move on rather than stop. One track that will not decode should cost
      // you that track, not the playlist.
      this.timer = setTimeout(() => this.next(), 1000);
      return;
    }
    // Muted, switched off, PAUSED or asked for something else entirely while it
    // was decoding — see `this.gen`. The pause is the one that was missing and
    // the one that costs two tracks at once.
    if (!this.on || !mix.armed || this.paused || gen !== this.gen) return;

    const ctx = mix.ctx;
    const now = ctx.currentTime;
    // Looping is sample-accurate in Web Audio — no gap and no click, and no
    // need for a tail-over-head crossfade, because a track written to loop
    // already ends where it begins. `source` is shared with `resume` so the
    // authored loop points cannot drift between the two.
    const src = this.source(buf, track);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(mix.out('music'));
    // Mid-track if we are picking up where a previous session left off. Spent
    // on use, or every later track in the session would start at the same
    // arbitrary offset.
    const from = this.seek;
    this.seek = 0;
    src.start(now, from);
    // The very first track of a session has nothing to cross with, so it comes
    // up over the short fade rather than taking ten seconds to become audible.
    const rise = this.node ? XFADE : FADE;
    gain.gain.setValueCurveAtTime(powerCurve(LEVEL, true), now, rise);

    // ...and the one it is replacing goes out underneath it, over the same
    // span, so the two sum to a flat level throughout.
    this.fadeOutAndStop(this.node, this.gain, rise);

    this.node = src;
    this.gain = gain;
    this.current = track;
    this.buf = buf;
    this.began = now;
    this.from = from;

    // Scheduled off the buffer's own length rather than `onended` — which never
    // fires now it loops, and even unlooped arrives *after* the last sample,
    // which is a hard stop you can hear.
    // The first pass is the whole file; every one after it is only the looped
    // span, so a track with an intro is shorter per repeat than its duration.
    const lap = (track.loopTo ?? buf.duration) - (track.loopFrom ?? 0);
    const repeats = Math.max(0, Math.round((SET - buf.duration) / lap));
    // The next track is started `XFADE` before this one's turn is up, not
    // after — the overlap comes out of the turn rather than being added to it,
    // so a two-minute set is still two minutes end to end.
    const runFor = Math.max(1, buf.duration + repeats * lap - XFADE);
    // Kept as well as scheduled, because a pause has to know how much of this
    // turn was left in order to give it back on resume.
    // A resumed track gets the rest of the turn it was already having, not a
    // fresh one — otherwise reloading is a way to keep any track playing for
    // ever, which you would find by accident within an afternoon of tweaking.
    this.left = this.resumeLeft != null ? Math.min(runFor, this.resumeLeft) : runFor;
    this.resumeLeft = null;
    // On repeat, nothing is scheduled and the source just keeps looping.
    if (!this.repeat) this.timer = setTimeout(() => this.next(), this.left * 1000);
  }

  /** What is playing, for the Sound tab. Null between tracks. */
  /**
   * What is on the radio — cued counts, not just sounding.
   *
   * Deliberately not gated on there being a live node: a paused radio still has
   * a station, and a screen that went blank between tracks would flicker on
   * every handover.
   */
  nowPlaying() { return this.current; }
}

export const music = new Music();
