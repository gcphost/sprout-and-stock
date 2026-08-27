/**
 * HOW LONG THE GPU ACTUALLY SPENT ON THE FRAME — the one number the frame clock
 * cannot get at, and the one that decides which half of the machine to blame.
 *
 * Everything the perf readout knew before this was measured on the CPU, and a
 * frame interval says nothing about where the time went. `render()` returns the
 * moment the last draw call is *submitted*; the GPU is still working on it long
 * afterwards, and the interval you measure next frame is however long the
 * browser decided to wait — which is the sum of our JS, the driver's queue, the
 * compositor and a vsync, with no way to tell those apart. So a shop at 10fps
 * and 100ms frames has at least three completely different causes and the
 * readout was equally consistent with all of them: too much JS per frame (fix
 * the sync loops), too many pixels or too much shading (fix the budget or the
 * pass), or neither of ours at all (a throttled tab, a background compositor, a
 * second display). Printing CPU time beside GPU time answers it in one glance,
 * and until it did, every "it feels chunky" report started with a guess.
 *
 * `EXT_disjoint_timer_query_webgl2` is the only way to ask, and it comes with
 * three traps that are each worse than not measuring.
 *
 * ONE: THE RESULT IS NOT READY WHEN YOU WANT IT. A timer query is answered by
 * the GPU, so asking for `QUERY_RESULT` before `QUERY_RESULT_AVAILABLE` blocks
 * the CPU until the pipeline drains — which is a profiler that creates the stall
 * it is reporting, and it does it *in proportion to how busy the GPU is*, so the
 * readout gets worse exactly when you are reading it. Always ask availability
 * first, and never in the same frame the query was ended. This one is polled on
 * later frames and lands a frame or two late; at a readout that updates four
 * times a second, nobody can tell.
 *
 * TWO: ONE AT A TIME. Only a single `TIME_ELAPSED_EXT` query may be *active* per
 * context, so this keeps one slot and simply does not start another until the
 * outstanding one has been read. Frames that fall in the gap are not measured,
 * which is the right trade for a number sampled at 4Hz — and it is why `ms` is
 * "a recent frame" rather than "the last frame", which the readout has to be
 * honest about.
 *
 * THREE: DISJOINT. The GPU can be interrupted between the two ends of a query —
 * another process taking the device, a power-state change, a context switch —
 * and the elapsed time it hands back then is nonsense rather than merely
 * imprecise, usually enormous. `GPU_DISJOINT_EXT` is the flag saying so, it is
 * *reset by being read*, and a profiler that ignored it would print a 400ms
 * spike every time the machine did something else. The whole result is thrown
 * away, not clamped.
 *
 * And the fourth thing, which is not a trap so much as the reason this file
 * degrades rather than throws: the extension is simply absent on a good share of
 * the machines the game runs on — Safari has never shipped it, and Chrome pulls
 * it on blocklisted drivers. `ms` stays `null` there, and the readout prints
 * that as `gpu -` rather than as a zero. A zero would read as "the GPU is free",
 * which is the exact opposite of "nobody can tell you", and it would send
 * somebody optimising the wrong half of the frame.
 */
export class GpuClock {
  constructor(renderer) {
    this.gl = renderer.getContext();
    // WebGL2 only. The WebGL1 spelling of this extension is a different API with
    // a different object model, and the renderer is WebGL2 everywhere three.js
    // will still start at all — so one path, and no path at all if it is missing.
    this.ext = this.gl.getExtension?.('EXT_disjoint_timer_query_webgl2') ?? null;
    /** Milliseconds the GPU spent on a recent frame, or null if it cannot say. */
    this.ms = null;
    this.query = null;
    this.open = false;
  }

  /** Is anybody going to answer? Read by the HUD to print `-` rather than 0. */
  get available() { return !!this.ext; }

  begin() {
    // Already one in flight, or nothing to ask. Skipping a frame is free; the
    // number is a sample rather than a series.
    if (!this.ext || this.query) return;
    this.query = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query);
    this.open = true;
  }

  end() {
    if (!this.open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.open = false;
  }

  /**
   * Collect the outstanding query if the GPU has got round to it. Called once a
   * frame, deliberately AFTER `end()` rather than before — the first poll then
   * falls on the next frame, which is the earliest an answer could exist anyway
   * and keeps the "never ask in the same frame" rule structural rather than
   * remembered.
   */
  poll() {
    if (!this.query || this.open) return;
    const { gl, ext } = this;
    if (!gl.getQueryParameter(this.query, gl.QUERY_RESULT_AVAILABLE)) return;
    // Read before the result, and read it EVERY time: the flag is cleared by
    // being read, so a poll that skipped it would hand the next query somebody
    // else's interruption.
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    if (!disjoint) this.ms = gl.getQueryParameter(this.query, gl.QUERY_RESULT) / 1e6;
    gl.deleteQuery(this.query);
    this.query = null;
  }

  dispose() {
    // The open case matters: a query left active is one the context carries for
    // as long as it lives, and it would refuse the next `beginQuery` outright.
    if (this.open) this.end();
    if (this.query) this.gl.deleteQuery(this.query);
    this.query = null;
  }
}
