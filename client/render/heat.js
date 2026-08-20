/**
 * WHERE THE SHOPPERS ACTUALLY GO.
 *
 * A sheet of colour over the ground: hot where people walk, clear where nobody
 * does. It is a diagnostic rather than a mechanic — nothing in the sim reads it
 * and nothing a worker does changes because of it.
 *
 * It exists because placement is the one decision in this shop you cannot see
 * the result of. Every other thing you spend money on says what it did: a till
 * has a queue, a shelf has stock on it, a hire has a job in their menu. Where
 * you put a unit shows you nothing at all, and the one rule that makes it worth
 * money — the endcap, a board within `IMPULSE_RADIUS` of a till — is deliberately
 * a thing you find rather than read. A dead corner and a busy aisle are the same
 * picture, so a shop with half its floor unvisited looks exactly like a shop
 * that is working.
 *
 * **It draws the SIM's map and keeps none of its own**, which is the decision
 * worth knowing before touching it. The first cut counted footfall here, off
 * the customer positions in each snapshot, and that was a second map: the crew
 * decide where stock goes from the sim's measure of where people walk, and the
 * picture you make the same decision by was drawn from another one. Two
 * heatmaps of one shop both look like heatmaps of that shop, so the
 * disagreement could never be seen — you would find the crew arranging things
 * the overlay did not explain and read it as the bots being stupid. What
 * counts as footfall, how it fades and where it is saved all live in
 * `server/sim/index.js` now (`noteTraffic`, `fadeTraffic`, `trafficWire`).
 *
 * **The scale is relative and says so.** The busiest cell is always full
 * brightness, because the absolute number is meaningless to a reader — what
 * anybody wants off this is *which* end of the shop, not how many. It does mean
 * an empty shop's one wandering shopper lights up like a rush, which is why
 * `MIN_SAMPLES` holds the sheet blank until there is something to compare.
 */

import * as THREE from 'three';

/**
 * How high the sheet floats, in tiles.
 *
 * Above the tallest ground there is — a plot at 0.08 — and far below the
 * shortest thing that stands on it, a counter at 0.55. So it lies over every
 * kind of floor and under every fixture, which is what makes it read as paint
 * on the ground rather than as fog in the room. Anything new in `TILE_STYLE`
 * taller than this pokes through, and looks like it.
 */
const LIFT = 0.11;

/**
 * How much footfall the map wants before it will draw anything.
 *
 * The scale is relative, so without this the first person through the door is
 * the hottest spot the shop has ever had and the map is a bright line following
 * one customer around. In seconds-of-footfall, which is what `noteTraffic`
 * accumulates — roughly a minute of one shopper walking about.
 */
const MIN_SAMPLES = 60;

/**
 * Below this share of the busiest cell, a cell is left clear.
 *
 * Not tidiness: with no floor at all every cell any shopper has ever clipped
 * the corner of carries a faint wash, and a sheet that is *everywhere* slightly
 * tinted is a sheet with no shape in it. The thing being looked for is the
 * contrast between the aisle and the corner.
 */
const CUT = 0.06;

/**
 * Cold to hot, and deliberately not red-against-green.
 *
 * That pair is the worst there is for a red-green colourblind reader — CLAUDE.md
 * records it costing the Shop report a contrast pass — and this is a readout
 * with no words on it at all, so the colour is doing every bit of the work. A
 * blue → teal → yellow ramp separates on lightness as well as on hue, which
 * means it still reads as a gradient in greyscale, and alpha climbs with it so
 * quiet ground stays quiet instead of being painted navy.
 */
const RAMP = [
  { at: 0.00, rgb: [0x3b, 0x51, 0x8b], a: 0.20 },
  { at: 0.35, rgb: [0x2a, 0x91, 0x8c], a: 0.36 },
  { at: 0.65, rgb: [0xa8, 0xc0, 0x4a], a: 0.50 },
  { at: 1.00, rgb: [0xf2, 0xb1, 0x33], a: 0.66 },
];

function rampAt(t) {
  for (let i = 1; i < RAMP.length; i++) {
    const b = RAMP[i];
    if (t > b.at && i < RAMP.length - 1) continue;
    const a = RAMP[i - 1];
    const k = b.at === a.at ? 0 : Math.min(1, Math.max(0, (t - a.at) / (b.at - a.at)));
    return [
      Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k),
      Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k),
      Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k),
      a.a + (b.a - a.a) * k,
    ];
  }
  return [0, 0, 0, 0];
}

export class Heat {
  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.renderOrder = 2;
    this.w = 0;
    this.h = 0;
    this.counts = null;
    this.total = 0;
    this.dirty = false;
    this.mesh = null;
    this.tex = null;
    this.pixels = null;
  }

  get on() { return this.group.visible; }

  /**
   * Match the map to the world, keeping what still lines up.
   *
   * A shop grows east and south (`grow`), so a world that got bigger has the
   * same tiles at the same coordinates and the old counts are still true of
   * them. Copying the overlap rather than starting again is what stops buying
   * land wiping a fortnight of watching — which would read as the overlay being
   * broken by a purchase, the same shape `refreshFixtureProps` exists to avoid.
   */
  resize(w, h) {
    if (w === this.w && h === this.h) return;
    const old = this.counts;
    const ow = this.w;
    const oh = this.h;
    this.w = w;
    this.h = h;
    this.counts = new Float32Array(w * h);
    if (old) {
      for (let z = 0; z < Math.min(oh, h); z++) {
        for (let x = 0; x < Math.min(ow, w); x++) this.counts[z * w + x] = old[z * ow + x];
      }
    }
    this.build();
    this.dirty = true;
  }

  build() {
    this.dispose();
    if (!(this.w > 0 && this.h > 0)) return;
    this.pixels = new Uint8Array(this.w * this.h * 4);
    this.tex = new THREE.DataTexture(this.pixels, this.w, this.h, THREE.RGBAFormat);
    // Per TILE, not smoothed. A blurred sheet looks better and is a different
    // claim: the shop is a grid, every rule in the game is about whole cells,
    // and a gradient that crosses a cell boundary invites reading a hot spot as
    // being half on a shelf. `client/render/scene.js` makes the same call about
    // the ground pattern for the same reason.
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.minFilter = THREE.NearestFilter;
    // The ramp is written in the same space `PALETTE`'s hexes are, and a
    // `DataTexture` defaults to being read as linear — so without this the
    // sheet comes out visibly paler than the colours it was authored from,
    // which reads as the ramp having been chosen badly rather than as a
    // conversion nobody asked for. `THREE.Color` does this for a material's
    // colour on its own, which is why nothing else in the renderer says it.
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.needsUpdate = true;

    const mat = new THREE.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      // Reads the depth buffer so shelves and walls stand in front of it, and
      // writes nothing back, so the sheet can never occlude whatever is drawn
      // after it. A readout that hid the shop would be a readout you turn off.
      depthWrite: false,
    });
    const geo = new THREE.PlaneGeometry(this.w, this.h);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.rotation.x = -Math.PI / 2;
    // Cell centres are integers, so the sheet's corner sits half a tile back.
    this.mesh.position.set(this.w / 2 - 0.5, LIFT, this.h / 2 - 0.5);
    this.mesh.renderOrder = 2;
    this.group.add(this.mesh);
  }

  /**
   * Take the shop's own map, as sent.
   *
   * The client used to count this itself, off the customer positions in each
   * snapshot. It worked, and it was a SECOND MAP — the crew decide where stock
   * goes from the sim's measure of where people walk, and the picture you make
   * the same decision by was drawn from another one. Both look like heatmaps of
   * the same shop, so a disagreement between them could never be seen; you
   * would simply find the crew arranging the shop in a way the overlay did not
   * explain, and read that as the bots being stupid.
   *
   * So there is one map, kept where the decisions are made, and this draws it.
   * Everything that used to live here went with it: the fade is the day roll's
   * (`fadeTraffic`), what counts as footfall is the sim's (walking shoppers,
   * never staff — see `noteTraffic`), and it is persisted on the save rather
   * than in this browser, so it is the same map on any machine that opens the
   * shop.
   *
   * Arrives every couple of seconds rather than every tick, and is simply
   * absent in between — see `trafficWire`.
   */
  adopt(grid) {
    if (!grid || !this.counts) return;
    if (grid.w !== this.w || grid.h !== this.h || !Array.isArray(grid.cells)) return;
    let total = 0;
    for (let i = 0; i < this.counts.length; i++) {
      const n = Number(grid.cells[i]) || 0;
      this.counts[i] = n;
      total += n;
    }
    this.total = total;
    this.dirty = true;
  }

  /**
   * Repaint the sheet from the counts. Only when something moved, and only
   * while it is being looked at — this walks every cell in the world, and a
   * shop nobody has the overlay open on should cost exactly nothing.
   */
  refresh() {
    if (!this.dirty || !this.on || !this.tex || !this.counts) return;
    this.dirty = false;
    const px = this.pixels;
    if (this.total < MIN_SAMPLES) { px.fill(0); this.tex.needsUpdate = true; return; }

    let max = 0;
    for (let i = 0; i < this.counts.length; i++) if (this.counts[i] > max) max = this.counts[i];
    if (!(max > 0)) { px.fill(0); this.tex.needsUpdate = true; return; }

    for (let z = 0; z < this.h; z++) {
      for (let x = 0; x < this.w; x++) {
        const t = this.counts[z * this.w + x] / max;
        // The texture's rows run the other way to the world's — a plane laid
        // flat puts v=0 at the far edge — so the row is flipped here rather
        // than by turning the mesh, which would also mirror x.
        const o = ((this.h - 1 - z) * this.w + x) * 4;
        if (t < CUT) { px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; px[o + 3] = 0; continue; }
        // Square-rooted, because footfall is very long-tailed — one doorway can
        // be ten times any aisle, and against a linear scale that leaves the
        // whole shop floor black with a bright dot on the mat. What is being
        // looked for lives in the quiet end of the range.
        const [r, g, b, a] = rampAt(Math.sqrt(t));
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = Math.round(a * 255);
      }
    }
    this.tex.needsUpdate = true;
  }

  setVisible(on) {
    this.group.visible = !!on;
    if (on) { this.dirty = true; this.refresh(); }
  }

  dispose() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.group.remove(this.mesh);
      this.mesh = null;
    }
    if (this.tex) { this.tex.dispose(); this.tex = null; }
  }
}
