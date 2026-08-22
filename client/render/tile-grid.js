/**
 * The debug grid — every tile wearing its own coordinates.
 *
 * Switched on with `?tiles` or from the Menu's switch grid (client/debug.js),
 * and off by default, because it is a tool for the
 * one conversation nobody has in the game: an agent says "the shelf at 11,23"
 * and you have no way at all to find 11,23 by looking. The shop has never drawn
 * a coordinate anywhere — `pickTile` answers the question for a press and then
 * throws the answer away — so the only way across that gap was to count aisles.
 *
 * Four things about it are decisions rather than details.
 *
 * It is **one mesh with one canvas texture**, not a label per cell. A sprite per
 * tile is fifteen hundred sprites on a grown farm, each with a canvas, a texture
 * and a material of its own, all of them turning to face the camera every frame
 * — which would make the debug overlay comfortably the most expensive thing in
 * the scene, and a readout that halves the frame rate is a readout that changes
 * what you are debugging.
 *
 * It lives in a group of its **own** rather than in `staticRoot`, and that is
 * the trap rather than a preference. `disposeGroup` frees geometry and instance
 * buffers and deliberately does NOT free materials, because every material in
 * the game comes out of the shared `material()` cache — right for the shop and
 * exactly wrong for this, which owns its material and a texture of a couple of
 * megabytes. Parked in `staticRoot` that texture would leak on every re-flow,
 * and build mode re-flows on every wall segment of a drag. It also would not
 * need to: what is drawn here depends on `w` and `h` and on nothing else in the
 * layout, so the only event that can invalidate it is buying land.
 *
 * It draws with **`depthTest: false`**. An overlay that fixtures occlude is one
 * you cannot read under the shelf you are trying to find, which is the whole of
 * what you asked it for. Same reason it is `MeshBasicMaterial`: the number has
 * to be as legible at 3am under a dead lamp as at noon.
 *
 * And it **thins rather than refuses** when the map outgrows the texture budget
 * — every fifth cell, on a heavier line, which is graph paper and still answers
 * "where is 11,23" in one glance. The same call `MAX_TUFTS` makes about the
 * lawn, for the same reason: the alternative is a mode that silently stops
 * working on exactly the big shops that are hardest to count your way across.
 */
import * as THREE from 'three';

// The longest side of the canvas, and how many of its pixels a cell would like.
// Both are larger than they need to be for a label that fills its cell, and
// that is the point: the label deliberately does NOT fill its cell (see
// `LABEL_WIDTH`), so the density has to come from somewhere or "smaller" just
// means "blurrier". A debug mode is the one place in the game where spending
// this much texture on nothing is the right call — it is off unless asked for,
// and it buys crisp numbers at the zoom you actually debug at.
const MAX_PX = 4096;
const IDEAL_CELL = 96;
// How much of a cell's width the label is allowed — a fraction, not a size, so
// it holds at every zoom and on every map. Numbers that fill their square read
// as the grid being made of text rather than as an annotation ON the shop, and
// at 45° the tails of one row run into the heads of the next.
const LABEL_WIDTH = 0.45;
// ...and when the grid is thinned there are four blank cells either side going
// spare, so the survivors get the room. Otherwise thinning — which happens on
// exactly the big maps that are hardest to count across — would hand you fewer
// labels AND smaller ones.
const THIN_WIDTH = 0.9;
// Under this many texture pixels a cell cannot hold a legible label at
// `LABEL_WIDTH`, so below it the grid labels every fifth cell instead.
const LABEL_FLOOR = 60;
const THIN = 5;

// Clear of every ground kind (pads are the tallest at 0.07) and well under the
// waist of anything standing on them. It barely matters with the depth test
// off, but a plane that is *geometrically* inside the shelves would still sort
// oddly against anything else drawn without depth.
const GRID_Y = 0.12;

/**
 * Draw the sheet: grid lines, and a label in every cell the budget can afford.
 */
function paint(w, h) {
  const cell = Math.max(8, Math.min(IDEAL_CELL, Math.floor(MAX_PX / Math.max(w, h))));
  const canvas = document.createElement('canvas');
  canvas.width = w * cell;
  canvas.height = h * cell;
  const c = canvas.getContext('2d');

  const every = cell >= LABEL_FLOOR ? 1 : THIN;
  const line = Math.max(1, cell / 32);

  // Lines first, so the text sits on top of them rather than being cut by the
  // next cell's edge.
  c.lineWidth = line;
  for (let x = 0; x <= w; x++) {
    // A labelled column gets the darker line, which is what makes a thinned
    // grid countable — the pale ones are the four you skip over.
    c.strokeStyle = x % every === 0 ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.16)';
    c.beginPath();
    c.moveTo(x * cell, 0);
    c.lineTo(x * cell, h * cell);
    c.stroke();
  }
  for (let z = 0; z <= h; z++) {
    c.strokeStyle = z % every === 0 ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.16)';
    c.beginPath();
    c.moveTo(0, z * cell);
    c.lineTo(w * cell, z * cell);
    c.stroke();
  }

  // Five characters of monospace is about three ems wide, so the em that fits
  // a label into its share of a cell is that share divided by three.
  const size = Math.max(6, Math.floor((cell * (every === 1 ? LABEL_WIDTH : THIN_WIDTH)) / 3));
  c.font = `bold ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  // White on a dark outline rather than any single colour: this goes over
  // grass, over cream floorboards, over grey tarmac and over a bay pad, and
  // there is no one ink that reads on all four.
  c.strokeStyle = 'rgba(0,0,0,0.85)';
  // A fifth of the em rather than a quarter: the stroke is centred on the glyph
  // edge, so half of it eats inward — heavy enough and a small label closes up
  // its own counters and becomes a black smudge with a white rim.
  c.lineWidth = Math.max(1.5, size / 5);
  c.lineJoin = 'round';
  c.fillStyle = '#ffffff';

  // Canvas row 0 is the top, and `CanvasTexture` flips Y — which lands the top
  // of the image at the plane's own +Y, and the plane is laid down so that +Y
  // points at -Z. So row 0 is z = 0 and this loop can be written the way you
  // would say it out loud. Worth checking if the plane's rotation ever changes,
  // because getting it wrong draws a perfectly convincing grid that is a mirror
  // of the shop.
  for (let z = 0; z < h; z += every) {
    for (let x = 0; x < w; x += every) {
      const label = `${x},${z}`;
      const px = (x + 0.5) * cell;
      const pz = (z + 0.5) * cell;
      c.strokeText(label, px, pz);
      c.fillText(label, px, pz);
    }
  }

  return canvas;
}

/**
 * A grid sized to this layout, or `null` if there is nothing to size it to.
 *
 * `anisotropy` comes from the renderer: this texture is looked at from 45° and
 * a long way off at the far end of the shop, which is the exact case anisotropic
 * filtering exists for — without it the numbers at the back smear into a line.
 */
export function buildTileGrid(w, h, anisotropy = 1) {
  if (!(w > 0 && h > 0)) return null;

  const tex = new THREE.CanvasTexture(paint(w, h));
  tex.anisotropy = anisotropy;
  tex.colorSpace = THREE.SRGBColorSpace;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      // Over the top of everything, and writing nothing: this is an annotation
      // on the picture rather than a thing in the shop.
      depthTest: false,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  // A tile is centred ON its integer — `pickTile` rounds rather than floors —
  // so the sheet spans -0.5 to w-0.5 and its middle is half a tile back from
  // where the arithmetic wants to put it.
  mesh.position.set((w - 1) / 2, GRID_Y, (h - 1) / 2);
  mesh.renderOrder = 999;
  // Nothing about this is part of the shop: it must never be picked, never cast
  // or receive a shadow, and never turn up in a raycast against the world.
  mesh.raycast = () => {};
  mesh.userData.debugGrid = true;

  return mesh;
}

/** Free the canvas texture and the material this one owns. */
export function disposeTileGrid(mesh) {
  if (!mesh) return;
  mesh.geometry?.dispose();
  mesh.material?.map?.dispose();
  mesh.material?.dispose();
}
