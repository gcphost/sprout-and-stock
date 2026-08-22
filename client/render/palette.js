/**
 * THE LOOK.
 *
 * Soft, saturated, flat-shaded pastels — the "tiny isometric shop" aesthetic.
 * Every colour in the game comes from here or from an item's own `model` JSON,
 * so changing the mood of the whole game is a one-file edit.
 */

import { T } from '../../shared/tiles.js';
import { E } from '../../shared/edges.js';

export const PALETTE = {
  grass: '#8ec96b',
  grassAlt: '#82bd60',
  soil: '#a8763f',
  soilDark: '#8d6234',
  /** Broken, workable soil — darker and damper than the rough ground. */
  soilTilled: '#7d5530',
  soilFurrow: '#6b4626',
  /** A plot nobody has turned over yet: scrubby, pale, still half turf. */
  soilRough: '#a89268',
  soilWeed: '#93b96a',
  /**
   * THE THREE PADS, WHICH USED TO BE THE LOUDEST GROUND IN THE SHOP.
   *
   * A bay was sage green, a drop-off was orange timber and a break area was
   * lilac, on the reasoning that three patches of ground doing three jobs have
   * to be told apart — which is true, and colour was the only thing any of them
   * had to say it with. What that bought is a shop floor with a purple rectangle
   * in the middle of it: the pads are big, they are rectangular, they are indoors
   * next to the parquet you chose, and the one thing they were never allowed to
   * do was blend in.
   *
   * They are MARKINGS now — see `PAD_MARK`. A painted bay in a real yard is the
   * same hardstanding as the yard with lines and a symbol on it, and that is the
   * whole idea: the fill drops back to a quiet tint of the ground it lies on, and
   * what says which pad it is moves onto the paint, where a disabled bay's
   * wheelchair says it without the tarmac having to be blue.
   *
   * So these are deliberately close to `floor` and `grass` and NOT to each
   * other — telling the three apart is the marking's job now, and any two of
   * these that drifted far enough apart to do it by colour would be putting the
   * rectangle back.
   */
  bay: '#ddd3bd',
  bayPlank: '#a8865c',
  /** The drop-off pad, where you park an armful. Half a step warmer than the
   *  bay, which is a hint rather than the answer — see above. */
  drop: '#e6d6b4',
  /** The break area: the one pad that is normally indoors, so it is the closest
   *  of the three to plain floor. */
  break: '#eadcc4',
  /** The car park: cold tarmac, and the darkest ground in the game on purpose.
   *  It is the one piece of hardstanding a customer sees before the shop, so it
   *  should read as the front of the building rather than as more of the back
   *  of it — the two yard pads are deliberately warm and light. */
  park: '#79808c',
  /** The paddock: the one pad that is not hardstanding at all. Grazed grass —
   *  greener and duller than the lawn beside it, which is the whole read. The
   *  four pads above are pale and warm because they are concrete you put things
   *  on; this one has to say "still a field, and something eats it". */
  paddock: '#9ab069',
  /** The road: darker than the car park it leads to, because the lane is the
   *  thing you drive on and the pad is the thing you stand on. Near-neutral on
   *  purpose — it is the longest run of one colour anybody will paint, so a
   *  road with any character in it would read as a stripe across the map. */
  road: '#5f646d',
  /** Last-resort bodywork — see `VEHICLE_LOOK`. Nothing on the road normally
   *  wears it: a vehicle row carries its own `color`, and its `model` carries
   *  the colours that actually get drawn. */
  vehicle: '#c9d1d9',
  floor: '#f0ddb8',
  floorAlt: '#e8d2a8',
  wall: '#fbf8f0',
  wallTop: '#eae5d6',
  shelf: '#b8875a',
  shelfTop: '#a2764c',
  freezer: '#cfe6ea',
  counter: '#7fd4c8',
  station: '#9aa4b0',
  stationTop: '#cfd8e3',
  counterTop: '#66c2b5',
  path: '#d9cbb0',
  fence: '#c99a63',
  // A hedge, and the one boundary that carries its OWN colour on its band —
  // which is what keeps paint off it, by the rule in `buildEdges` that a band
  // with a colour already on it is left bare. Nobody paints a hedge. Two greens
  // because the top is what you see most of at 45° and a single one draws a
  // green slab; darker at the face, lighter on the clipped top, the way a
  // planting reads in daylight.
  hedge: '#5f7f4a',
  hedgeTop: '#7a9b5c',
  // A railing: dark posts and a lighter top rail, so the horizontal reads
  // against the ground rather than dissolving into it. Both carry their own
  // colour for the hedge's reason — you paint a railing in practice, and the
  // finish tool paints a WALL FACE, which is a surface a rail simply has not
  // got.
  railing: '#8a8579',
  railingRail: '#b6b0a2',
  door: '#f6f3ea',
  // A strip curtain: milky PVC on a metal rail. Deliberately opaque rather than
  // glass — the alpha band in `edgeBands` is one shared value (`GLASS`, 0.35),
  // which on something the size of a wall reads as an absence, and the thing
  // that makes strips read as strips is the GAP between them rather than seeing
  // through the plastic. The tint is cool against `wall` so a curtained-off
  // corner is legible as a different material from across the room.
  curtain: '#dfe9e6',
  curtainRail: '#9aa4b0',
  // A roller shutter, coiled up under its own lintel. Galvanised rather than
  // painted, and two shades of it: the coil is read edge-on at this camera, so
  // what says "slats" is the banding across it and a single colour would draw a
  // grey pelmet. The track is darker than both, which is what keeps the jambs
  // from reading as part of the roll.
  shutter: '#c6ccd4',
  shutterDeep: '#a4adb8',
  shutterTrack: '#868f9a',
  // A rule painted across a threshold. What a signed way through gets instead of
  // its own geometry: a staff door and a doorway are the same hole in the same
  // wall, so the only honest difference is a marking on the floor of it — which
  // is what a real shop does about exactly this, and which reads from across the
  // room at this camera pitch where a plate on the lintel does not.
  markStaff: '#8d95a6',
  markIn: '#6fbf73',
  markOut: '#e8a44b',
  // The awning's two stripes used to live here, because the renderer drew the
  // shop front itself. They are on the `awning` catalog row now — a piece
  // carries its own colours, which is what lets there be a second design of one.
  sky: '#cfe9f5',

  // Open and close. The sun sits low and throws long warm light, so the sky
  // goes with it — brightness alone reads as "the monitor dimmed", where a
  // colour shift reads as evening.
  skyDusk: '#f7c9a2',
  /** Sun colour at noon and at the edges of the day. */
  sunHigh: '#fff4dd',
  sunDusk: '#ff9e5e',
  /** Ambient fill: warm and open at noon, cool and blue once the sun is down. */
  fillHigh: '#ffffff',
  fillDusk: '#8fa6c8',
};

/** Player colours, cycled by join order. */
export const PLAYER_COLORS = ['#5b8ff9', '#f2a03d', '#7cc46a', '#c98ad9'];

/**
 * Tile kind -> how it renders.
 * `h` is height in world units; 0 means "flat, draw on the ground".
 * The kind numbers themselves come from `shared/tiles.js`, which is the one
 * place the server, the build validator and this file all agree.
 */
export const TILE_STYLE = {
  // Drawn, and the lowest ground there is. It used to be `h: 0` and skipped
  // outright by `buildWorld` — what you saw was the apron plane underneath, one
  // flat colour with none of the per-cell jitter or baked lamp light every other
  // kind of ground gets. A hair rather than nothing because the road is 0.02 and
  // deliberately flush: a lawn that stood level with the tarmac would put the
  // kerb back that `T.ROAD` says in as many words it does not want.
  [T.GRASS]: { color: PALETTE.grass, h: 0.01 },
  [T.FLOOR]: { color: PALETTE.floor, h: 0.06 },
  [T.WALL]: { color: PALETTE.wall, h: 1.1 },
  // The plot tile is only the bed. Whether it reads as rough turf or turned
  // earth is per-plot state, so the renderer lays that on top in syncPlots.
  [T.PLOT]: { color: PALETTE.soilRough, h: 0.08 },
  [T.DOOR]: { color: PALETTE.door, h: 0.06 },
  [T.PATH]: { color: PALETTE.path, h: 0.05 },
  [T.FENCE]: { color: PALETTE.fence, h: 0.45 },
  // Level with the floor rather than the 0.07 they stood at. A pad indoors is
  // ground you have painted, not a platform you have built, and a tenth of a
  // tile of lip along its edge is exactly what made one read as a slab dropped
  // on the shop — the same argument `T.ROAD` makes about a kerb, one storey
  // down. Outdoors the lip survives against grass, which is right: there a pad
  // IS hardstanding.
  [T.BAY]: { color: PALETTE.bay, h: 0.06 },
  [T.DROP]: { color: PALETTE.drop, h: 0.06 },
  [T.BREAK]: { color: PALETTE.break, h: 0.06 },
  [T.PARK]: { color: PALETTE.park, h: 0.06 },
  // Flush with the grass, unlike the four pads above it, and for `T.ROAD`'s
  // reason rather than in spite of it: a paddock is a field somebody has fenced
  // off, not a slab laid on one, and a lip round the edge of a meadow would read
  // as a raised bed the size of the farm.
  [T.PADDOCK]: { color: PALETTE.paddock, h: 0.02 },
  // Flush with the grass rather than raised the 0.07 the pads are. A pad is a
  // platform you put things on and a road is ground you drive over, and a lip
  // along a lane that runs the width of the map would read as a kerb the van
  // climbs.
  [T.ROAD]: { color: PALETTE.road, h: 0.02 },
};

/**
 * What a fixture looks like when nobody has drawn one.
 *
 * These are the four tile styles that left `TILE_STYLE` when fixtures stopped
 * being tiles, kept to the colour and height they always were — so an unauthored
 * kind renders exactly as it used to rather than as nothing at all. Every kind
 * in the shipped catalog has a model, so in practice this is what a brand new
 * kind looks like on the day it becomes buildable and before anybody styles it.
 *
 * It is also what the build ghost is sized from, which is the more important
 * job: the ghost is a box saying "something lands here", and it should be the
 * size of the something.
 */
export const FIXTURE_LOOK = {
  shelf: { color: PALETTE.shelf, h: 0.75 },
  freezer: { color: PALETTE.freezer, h: 0.65 },
  checkout: { color: PALETTE.counter, h: 0.55 },
  station: { color: PALETTE.station, h: 0.7 },
  // A plot is the ground, so its own tile is the whole look and a block on top
  // would bury the soil. Zero height, and `syncPlots` draws the bed.
  plot: { color: PALETTE.soilRough, h: 0 },
  // Only ever seen by a shop whose pen nobody has drawn. Waist-high and
  // blocking, so an undrawn one is a thing you can see you would walk into —
  // `warmer`'s lesson, which cost the hot counter an invisible fixture.
  pen: { color: PALETTE.shelf, h: 0.6 },
  // Only ever seen by a shop whose skip nobody has drawn — the shipped row has
  // art. Waist-high and blocking, so an undrawn one is still a thing you can
  // see you would walk into.
  bin: { color: PALETTE.station, h: 0.6 },
  // `warmer` was missing from this table for the whole life of the hot counter,
  // and it never showed because the shipped row has art — an undrawn one is
  // `plainBlock(undefined)`, which is null, which `addFixtureProps` skips: an
  // invisible fixture you can walk into, with nothing anywhere to say so.
  warmer: { color: PALETTE.counter, h: 0.65 },
  // Low, because a belt is walked over and anything waist-high here would read
  // as a wall down the aisle. Not zero like a plot, though — a conveyor stands
  // proud of the floor, and `fixtureHeight` reads this to aim at it.
  belt: { color: PALETTE.station, h: 0.12 },
  // A loader is a HOUSING the track runs into — the crate goes inside and is not
  // drawn — so this is the height of the machine rather than of the belt it
  // stands in. It was 0.18, which was the run's own height back when a loader
  // was a deck with a cabinet beside it, and left there it aims the pointer and
  // the ghost at the track under the box you are trying to press.
  arm: { color: PALETTE.station, h: 0.78 },
  // ...and the same again for a junction, for the same reason.
  sorter: { color: PALETTE.station, h: 0.78 },
  // ...and for a tunnel mouth. Missing, this is `undefined`, `plainBlock`
  // answers null and the fixture is never added to the scene AT ALL — no mesh
  // to raycast, so it cannot be pointed at, turned, bulldozed or shift-deleted,
  // and what stands in the shop is the rail loop with bare ground inside it.
  // `fixtureHeight` reads this to aim, which is what makes it the difference
  // between a piece you can get rid of and one you cannot.
  under: { color: PALETTE.station, h: 0.3 },
  'prop-floor': { color: PALETTE.floor, h: 0.3 },
  'prop-ceiling': { color: PALETTE.floor, h: 0.3 },
};

/**
 * What a vehicle looks like when there is no art to draw.
 *
 * The same fallback `FIXTURE_LOOK` is, for the same reason — an invisible thing
 * is worse than a generic one — but it answers a different question, and the
 * difference is worth writing down. A fixture kind can genuinely have no model:
 * it becomes buildable before anyone styles it, and this is what it looks like
 * that day. A vehicle cannot, because `VehicleSchema` requires one. So this is
 * only ever reached two ways: the row was deleted out from under a van already
 * on the road, or somebody authored a stage with nothing in it. Both are the
 * case where a paid-for delivery arrives as *nothing at all*, which is
 * indistinguishable from a delivery that never came — and telling those apart
 * is the entire reason the van exists.
 *
 * Longer than it is wide, because that is the one thing true of a vehicle
 * before you know which one it is. A cube on the tarmac reads as a crate, and a
 * crate at the bay is a thing the game already draws and means something else by.
 *
 * The colour is the last resort of the last resort. A row that still exists
 * carries its own `color`, which is what "bodywork, where the model doesn't say
 * otherwise" means on the schema; this is for when even the row has gone.
 */
export const VEHICLE_LOOK = { color: PALETTE.vehicle, l: 1.4, w: 0.7, h: 0.6 };

/**
 * THE CONVEYOR, WHICH USED TO BE THE DARKEST THING IN THE SHOP.
 *
 * A belt was `#2f333a` — near black — with slate `#5b6472` slats, in a shop
 * whose floor is `#f0ddb8` and whose walls are `#fbf8f0`. Two things came of
 * that, and neither of them is a bug anywhere:
 *
 * - **In daylight it read as a hole cut in the floor.** Everything else here is
 *   light and warm, so a black slab was out of key with the entire art
 *   direction rather than merely dark — it looked like industrial plant dropped
 *   into a bright friendly shop, which is exactly what black steel and rubber
 *   slats are a picture of.
 * - **At night it disappeared.** A thing that is only a *value* — dark on
 *   light — has nothing left once the light goes, and a run of belt is the one
 *   fixture you most want to be able to trace across a dark shop.
 *
 * So the whole family is re-keyed to pale polymer, which is also what makes it
 * read as modern: real intralogistics gear stopped being painted steel a decade
 * ago and is now light grey plastic with one coloured light on it. The light is
 * the other half — see `CONVEYOR_LIT` below.
 *
 * Named roles rather than hexes at the call sites, because the same six colours
 * are spelled in two places that cannot see each other: the authored `fixtures`
 * rows (the deck, the slats, the chevrons) and the meshes the renderer derives
 * (kerbs, chamfers, a loader's cabinet, a tunnel throat). A run whose authored
 * half was repainted and whose derived half was not is a belt with a dark kerb
 * down one side of it, which reads as a rendering fault.
 */
export const CONVEYOR = {
  /** The bed goods ride on. The lightest thing in the family. */
  deck: '#c8d0da',
  /** The recess goods travel in, and the carriers that travel in it.
   *
   *  NOT SLATS, and that is the whole of what the re-key was actually for. A
   *  slat belt is a picture of 1975 whatever colour it is painted — repainting
   *  one pale fixes the value problem and leaves you looking at the same
   *  machine. Every rung is a track with carriers gliding in it now, and the
   *  ladder climbs by carrier (steel, then lit, then maglev) rather than being
   *  a slat belt at the bottom that turns modern at the top.
   *
   *  The renderer draws one of these too — the little feed out of a loader's
   *  cabinet — so the pair lives here rather than only in the authored rows,
   *  or a loader stays a slat belt bolted to a track. */
  track: '#4a525e',
  carrier: '#7f8d9e',
  /** What a slat used to be. Kept because a `fixtures` row somebody authored
   *  before this could still be wearing bars, and an unmapped colour is worse
   *  than an old-fashioned one. */
  slat: '#8b96a6',
  /** Kerbs, chamfers and straps: the lip of the track. */
  rail: '#414956',
  /** A machine's body — a loader's cabinet, a sorter's housing. A shade up from
   *  the rail so it reads as an object standing in the run rather than as more
   *  of the run, and dark like everything else the run is made of: these were
   *  pale grey back when they stood on a pale deck, and once the deck came off
   *  they were the last of it — a row of light chunks along a dark track, which
   *  is the same out-of-key complaint the belt itself started with, pointed at
   *  the machines instead of the ground. The lamp is the bright part. */
  frame: '#4e5865',
  /** Chevrons and the small dark details. Darker than the deck on purpose: on a
   *  pale bed the direction mark is the thing that has to be legible, and it was
   *  authored LIGHTER than its slats back when the deck was nearly black. */
  trim: '#6c7784',
  /* No `well`. A join mark used to sit in a recess — a shade under the deck, so
     the eye read something lit at the bottom of a socket — and it went twice:
     first as `#1b1f26`, a sensible recess in a nearly-black belt and a hole
     punched in a pale one, then as a grey chip lying on the floor once the deck
     came off entirely. A lit mark on bare ground needs no socket, because it is
     the only thing on the cell that glows. */
  /** A recess, and the one place a conveyor is still allowed to be dark: a
   *  tunnel throat is a hole, and a hole that is not dark is a decal. */
  shadow: '#3b424e',
};

/**
 * ...and the light along it, which is the half that works at night.
 *
 * Three states, and they are a READOUT rather than decoration: a run tells you
 * what it is doing from across the shop, without hovering anything, the way the
 * loader lamps already do. Flowing, jammed, idle.
 *
 * `on` is the green the loader lamps already use, deliberately — a belt that
 * has a box on it and a loader that just took one are the same fact reported by
 * two pieces, and two greens would read as two different facts.
 *
 * These are drawn UNLIT (`MeshBasicMaterial`), which is what makes the night
 * case work and is also why they must be bright rather than merely coloured:
 * nothing shades them, so a mid-tone here looks like paint instead of light.
 */
export const CONVEYOR_LIT = {
  /** Carrying something. */
  on: '#63d489',
  /** Backed up — the box has nowhere to go. Amber, and it propagates back down
   *  the run, which is the whole thing this readout is worth: a jam at the head
   *  lights every cell behind it and you can see where it started. */
  jam: '#e8a33c',
  /** Empty. DARKER THAN THE TRACK, and it was the other way round for as long
   *  as the deck was pale: "dim" was reasoned about a light going out, and a
   *  light that goes out on a pale deck is a hole, so idle was a quiet grey
   *  ABOVE the deck it lay on. The deck is a dark recess now (`track`), which
   *  inverts the whole argument — a pale pip on a dark groove is the brightest
   *  thing on the run saying the least, one per join, all the way down a line
   *  that is doing nothing. A joint is darker than the metal either side of it.
   *  The two lit states above are unchanged and are now the only things on a
   *  run that are lighter than the run. */
  idle: '#39414c',
};

/**
 * THE CRATE, WHICH RODE THE CONVEYOR IN LOOKING LIKE A FRUIT BOX.
 *
 * It was `#a8763f` — the same hex as `soil`, pallet boards underneath and four
 * plank walls — which was right in a shop where the only things that moved
 * goods were people and a lorry. The belts re-keyed the whole logistics family
 * to pale polymer, and the box a machine hands to another machine is the one
 * thing that touches every part of that chain: bay, shoulder, deck, arm, shelf.
 * A timber box on a moulded track is the same "industrial plant dropped into
 * the wrong picture" the black belt was, arriving from the other direction.
 *
 * So it is a moulded tote, and the split of the four colours is the design
 * rather than a shading pass. **The body is the darkest thing here that isn't a
 * detail**, and that is a legibility rule rather than taste: a crate spends its
 * life standing on `deck` (`#c8d0da`) and on `floor` (`#f0ddb8`), so a pale box
 * is a box you cannot find — the belt readout says a cell is carrying something
 * and the something has to be visible from the same distance.
 *
 * **The goods are the colour.** Wood is warm and saturated and it argued with
 * every tomato standing in it; a neutral cool grey is a backdrop, which is the
 * whole reason real totes are grey.
 *
 * And what says *moulded* at this camera is the LIP. A box drawn as four flat
 * walls reads as sheet material whatever it is painted, so the top edge stands
 * proud in near-white — from a 40° camera that rim is most of what you see of an
 * empty crate, and it is the one part that catches a light at night.
 */
/**
 * WHAT IS PAINTED ON A PAD, NOW THAT THE PAD ITSELF SAYS NOTHING.
 *
 * The four job pads used to be told apart by the colour of the ground, which is
 * the one cue that cannot be quiet — see `PALETTE.bay`. A real yard does this
 * the other way round: the tarmac is tarmac everywhere, and what a bay is FOR is
 * a line round it and a symbol in the middle of it. A disabled space is the
 * example worth holding on to, because everybody reads one instantly and none of
 * it is the colour of the ground.
 *
 * Two marks per pad and they do different jobs. The **line** says where the pad
 * ends, which is the half the fill used to carry and the half that matters while
 * you are building — how big you painted it is how much it holds, for every one
 * of these. The **symbol** says which pad it is, once per region rather than
 * once per cell: a glyph stamped on every square is a tiled wallpaper, and the
 * thing being imitated is one big sign painted on the ground.
 *
 * The ink is a shade of the ground rather than a colour of its own, for the
 * reason the whole re-key exists — paint on concrete is concrete you can see the
 * paint on. `park` is the exception and inverts, because tarmac is the one pad
 * dark enough that a darker line on it is invisible.
 */
export const PAD_MARK = {
  [T.BAY]: { ink: '#a2988a', glyph: 'load' },
  [T.DROP]: { ink: '#ad9b78', glyph: 'stock' },
  [T.BREAK]: { ink: '#bcac92', glyph: 'charge' },
  [T.PARK]: { ink: '#cdd3db', glyph: 'park' },
  // The paddock is deliberately NOT in here, and it is the one pad that should
  // never be. Both marks are paint, and the sentence above is that paint on
  // concrete is concrete you can see the paint on — a field is the one pad with
  // no concrete in it, so a white line round a meadow reads as a tennis court.
  // What tells you where it ends is that something is grazing inside it.
};

export const CRATE_LOOK = {
  /** The tote itself. */
  body: '#93a1b2',
  /** The rim, standing proud of the walls. The brightest part of the box. */
  lip: '#e2e8ef',
  /** Corner posts — the mouldings a stack interlocks by, which is why they run
   *  the full height and stand a hair outside the walls. */
  post: '#5d6875',
  /** The skid it stands on, inset so the box reads as sitting on a foot rather
   *  than as a solid block. Darkest, because it is in its own shadow. */
  skid: '#4c5561',
};

/**
 * ...and the same tote in the drab it comes back as once it is holding rot.
 *
 * Same silhouette on purpose — see `buildPallet`: what tells you it is rubbish
 * is where it is and who is carrying it, and a second shape would be a new
 * object to learn for a box that behaves like every other box. Olive-grey and
 * flatter, so it reads as spoiled from across the shop without the goods inside
 * having to change colour. The lip comes down with it: a bright rim on the skip
 * box would make rubbish the crispest thing in the yard.
 */
export const WASTE_LOOK = {
  body: '#79796a',
  lip: '#a5a492',
  post: '#4f5045',
  skid: '#43443b',
};

/**
 * The three things an edge can be made of, once each.
 *
 * Written down here rather than eight times below, because a signed doorway is
 * the same doorway and a bay window is the same wall with glass in it — see
 * `WAYS` and `GLAZING` in shared/edges.js, which is where the difference between
 * those two lives. Spreading the base by hand is how you end up with a staff door
 * that stayed white when somebody restyled the wall.
 */
const EDGE_BASE = {
  // A doorway is a gap you can walk through: a header spanning the opening and
  // a threshold underfoot, with nothing in between.
  door: { color: PALETTE.wall, top: PALETTE.wallTop, h: 1.1, t: 0.17, opening: true },
  gate: { color: PALETTE.fence, h: 0.5, t: 0.14, opening: true },
  // ...and a curtain is the other way up: strips hanging from a rail, with the
  // gap at the BOTTOM rather than in the middle. `drop` is where they stop, and
  // it is the whole authored fact about the piece — everything else falls out of
  // it. See `CURTAIN_DROP` for what sets the number.
  //
  // `color` is the WALL and not the plastic, which is doing three jobs at once.
  // The pelmet the strips hang off is wall, so it takes paint the way a window's
  // frame does; the palette button draws its stubs in the base colour, so a
  // curtain reads as strips set in a wall rather than as a milky slab with a
  // fringe in it; and the strips carrying their own colour is what keeps a
  // finish off them, which is right — nobody paints PVC.
  curtain: {
    color: PALETTE.wall, top: PALETTE.curtainRail, h: 1.1, t: 0.1, curtain: true,
  },
  // ...and a roller door is a doorway with the machinery drawn: the same header
  // and the same threshold, plus the coil that is the whole reason you can tell
  // it is one, and a track down each jamb. `color` is the WALL for the reason
  // the curtain's is — the lintel takes paint the way a window frame does, and
  // the slats carrying their own colour is what keeps a finish off galvanised
  // steel. Thicker than a plain wall (a shutter box stands proud of the
  // brickwork) and the tracks ride that thickness for free.
  shutter: {
    color: PALETTE.wall, top: PALETTE.wallTop, h: 1.1, t: 0.2, shutter: true,
  },
  // ...and a window is a wall with a hole in the middle of it. `sill` and `head`
  // are where the glass starts and stops, and they are the WHOLE difference
  // between the four glazings — see `GLAZING` in shared/edges.js. Anything that
  // wanted a fifth look should be two numbers here and nothing else.
  glass: { color: PALETTE.wall, top: PALETTE.wallTop, h: 1.1, t: 0.17, glass: true },
  // An arch is a doorway with the door left out and the span built in, so it is
  // the doorway's own base with one flag changed. Thicker, because the courses
  // that close the head in are a pier's worth of masonry rather than a frame's —
  // and the thickness is what makes the corbels read at 45°, since what you see
  // of a step is its top face.
  arch: { color: PALETTE.wall, top: PALETTE.wallTop, h: 1.1, t: 0.22, arch: true },
  // A boundary. One base for all four looks, because every fact the sim has about
  // them is shared — see `FENCING`, shared/edges.js. Each look overrides only
  // what it is made of.
  fence: { color: PALETTE.fence, h: 0.5, t: 0.14 },
};

/**
 * Edge kind -> how it renders.
 *
 * `t` is thickness across the boundary, in tiles. A wall is thin because it
 * sits *on* the line between two cells rather than filling one — which is where
 * the two tiles of shop floor per side came back from.
 */
export const EDGE_STYLE = {
  [E.WALL]: { color: PALETTE.wall, top: PALETTE.wallTop, h: 1.1, t: 0.17 },
  [E.WINDOW]: EDGE_BASE.glass,
  [E.DOOR]: EDGE_BASE.door,
  [E.GATE]: EDGE_BASE.gate,
  // Glass to the lintel over a kick plate. `shadow` because a pane this size is
  // the *wall*: glass casts none by default, which is right for a bottle and a
  // freezer door and wrong for a shopfront — a building whose south face stops
  // laying a shadow on its own forecourt reads as the wall having gone.
  [E.WINDOW_FULL]: { ...EDGE_BASE.glass, sill: 0.05, head: 1.02, shadow: true },
  // Standard glazing, pushed out over a sill. `out` is the one thing here that is
  // geometry rather than a pair of heights, and the renderer decides WHICH WAY out
  // is off the enclosure — a bay projects into the street, not into the aisle.
  [E.WINDOW_BAY]: { ...EDGE_BASE.glass, sill: 0.34, head: 0.95, out: 0.2 },
  // A strip up under the lintel. Light without a view, which is what you want on
  // a stockroom and on anything a passer-by should not be able to see the till
  // through.
  [E.WINDOW_HIGH]: { ...EDGE_BASE.glass, sill: 0.72, head: 1.02 },
  [E.FENCE]: EDGE_BASE.fence,
  // Three more boundaries, and they are LOOKS rather than kinds — one price, one
  // set of rules, free to swap between (`FENCING`, shared/edges.js). Only a
  // hedge is thicker, and that is not a rule either: planting has depth, and a
  // hedge drawn at a panel's thickness is a green fence.
  //
  // The hedge and the railing carry their own colours, which is what keeps the
  // paint tool off them — a band with a colour on it is skipped by `buildEdges`.
  // A LOW WALL deliberately does not, so it takes a finish exactly as the wall
  // it is half of does. That is the one difference between these four that is
  // worth more than a colour, and it is a consequence rather than a rule.
  [E.HEDGE]: { ...EDGE_BASE.fence, color: PALETTE.hedge, top: PALETTE.hedgeTop, h: 0.62, t: 0.3 },
  [E.RAILING]: {
    ...EDGE_BASE.fence, color: PALETTE.railing, rail: PALETTE.railingRail,
    h: 0.55, t: 0.08, railing: true,
  },
  [E.LOW_WALL]: { ...EDGE_BASE.fence, color: PALETTE.wall, top: PALETTE.wallTop, t: 0.17 },
  // An arch, and the same arch with a rule on it. The mark rides on the
  // threshold exactly as a doorway's does, because an arch is a hole you walk
  // through the middle of and has a step under it for the same reason.
  [E.ARCH]: EDGE_BASE.arch,
  [E.ARCH_STAFF]: { ...EDGE_BASE.arch, mark: PALETTE.markStaff },
  // The same hole in the same wall, with the threshold painted. `mark` is the
  // whole difference, and it is a difference you can SEE — the feature is
  // otherwise invisible in a screenshot, which is a fine thing to say about a
  // rule the sim obeys and a poor thing to say about a switch you flipped and
  // want to check. Derived off the base rather than written out, so restyling a
  // wall takes every signed door with it.
  [E.DOOR_STAFF]: { ...EDGE_BASE.door, mark: PALETTE.markStaff },
  [E.DOOR_IN]: { ...EDGE_BASE.door, mark: PALETTE.markIn },
  [E.DOOR_OUT]: { ...EDGE_BASE.door, mark: PALETTE.markOut },
  [E.GATE_STAFF]: { ...EDGE_BASE.gate, mark: PALETTE.markStaff },
  // The mark rides on the RAIL rather than on a threshold, because a curtain
  // does not have one — the gap under it is the piece. Same argument as the
  // painted step under a signed doorway: who a way through is for is invisible
  // otherwise, and this is a rule you flip and then want to check.
  [E.CURTAIN]: EDGE_BASE.curtain,
  [E.CURTAIN_STAFF]: { ...EDGE_BASE.curtain, mark: PALETTE.markStaff },
  // The mark goes back on the threshold here, where a curtain had to move it to
  // the rail: a roller door is a hole you walk through the middle of, so it has
  // a step under it exactly as a doorway does, and putting the stripe on the
  // shutter box would hide it behind the coil from every camera angle.
  [E.SHUTTER]: EDGE_BASE.shutter,
  [E.SHUTTER_STAFF]: { ...EDGE_BASE.shutter, mark: PALETTE.markStaff },
  [E.SHUTTER_IN]: { ...EDGE_BASE.shutter, mark: PALETTE.markIn },
  [E.SHUTTER_OUT]: { ...EDGE_BASE.shutter, mark: PALETTE.markOut },
};

/** How see-through a pane of glass is. Read by the geometry and the material. */
export const GLASS = 0.35;

/**
 * The line an edge's own detail has to start above: the tallest ground the shop
 * can be standing on.
 *
 * An edge is drawn from world zero and the ground is not — a floor slab is 0.06
 * tall and a delivery bay 0.07 (`TILE_STYLE`) — so every number in `edgeBands`
 * under this is a band drawn *inside the floor*. That is fine for the one band
 * whose job is to span the whole wall, which is solid and taller than anything
 * it passes through, and it is wrong for everything else, in two ways that look
 * like different bugs:
 *
 * - A doorway's threshold sat at 0.02..0.05, entirely under the floor's top
 *   face. Two near-coplanar surfaces, one depth buffer, and the winner depends
 *   on the camera — which is why it read as the bottom of a door bleeding
 *   through the ground at *some* angles and being fine at others.
 * - A shopfront's glass started at 0.05, so the pane passed clean through the
 *   floor slab. A transparent box intersecting an opaque one draws a bright
 *   seam along the intersection, and the kick plate below it (0 to 0.05) was
 *   never once visible in the whole life of the piece.
 *
 * So it is the *floor line* rather than a number nudged until the artefact went
 * away on one camera — the two callers below both clamp to it, and a fifth
 * glazing authored with its sill on the deck gets the fix by construction.
 */
const GROUND_LINE = 0.08;

/**
 * Where a curtain's strips stop, and what decides it.
 *
 * Not a feel number: it is the tallest thing that has to pass UNDER one. A crate
 * riding a conveyor sits on `BELT_DECK` (0.12) and stands `CRATE_STEP` (0.27),
 * so the top of the tallest thing a curtain must clear is 0.39 — and the point
 * of the piece is that a run of belt carries straight on through it while a
 * shopper cannot. Strips that grazed the box would read as the crate clipping
 * the wall, which is the same picture as a bug in the belt.
 *
 * A hand's width over that, and no more. Every centimetre above this is a hole
 * in the partition you can see the stockroom through.
 */
const CURTAIN_DROP = 0.5;

/**
 * How many strips one cell of curtain is cut into, and how much of the pitch
 * each one covers.
 *
 * The gap is the entire reason this is geometry rather than a colour, and it is
 * the argument `stripes` and `tufts` already make about the ground: what
 * survives of a flat pattern at 45° across a room is its colour. Six per cell
 * against a cell that is a metre and a half puts a strip at about the width of a
 * real one, and 0.86 of the pitch leaves a joint you can see without leaving a
 * window you can see the shop through.
 */
const CURTAIN_STRIPS = 6;
const CURTAIN_DUTY = 0.86;

/**
 * A roller shutter that is UP, and the three numbers that say so.
 *
 * The picture has to carry the whole claim on its own, because nothing else
 * does: an open roller door and a doorway are the same hole in the same wall to
 * every rule in the game (they cost different money and that is it), so if the
 * coil and the tracks do not read at a glance then what you have bought is a
 * doorway at a mark-up. Same argument the painted threshold under a signed door
 * makes about a rule you cannot otherwise see.
 *
 * `SHUTTER_COIL` is how far the roll hangs below the lintel and it is a
 * headroom decision rather than a look: everything that walks through here
 * clears `CURTAIN_DROP`, and a coil that dropped past halfway would be a
 * doorway with a low bar across it — which reads as a shutter stuck halfway
 * down, i.e. the one state this piece is not in.
 *
 * `SHUTTER_RIBS` is what makes the coil a coil. Three courses, alternating,
 * because a single slab of grey under a lintel is a pelmet — this is `stripes`,
 * `tufts` and the curtain's own strips making the same argument for the fourth
 * time: what survives of a flat pattern across a room at 45° is its colour, so
 * the banding is geometry.
 *
 * `SHUTTER_TRACK` is the width of the guide down each jamb. Wide enough to see
 * from across the shop, narrow enough that a run of them does not close the
 * opening up — and it is drawn INSIDE the cell rather than on the line between
 * two, so a two-cell bay reads as a pair of doors rather than as one wide one.
 * That is honest: each cell is separately a way through, and each one is
 * separately something you can sign.
 */
const SHUTTER_COIL = 0.22;
const SHUTTER_RIBS = 3;
const SHUTTER_TRACK = 0.11;

/**
 * An ARCH, and the three numbers that keep it from being a doorway.
 *
 * The whole of what you are buying here is the picture — an arch encloses like a
 * doorway, is crossed like a doorway and is signed like a doorway, so if the
 * span does not read at a glance then it is a doorway at a different price. Same
 * argument the shutter's coil makes, and it bites harder: a shutter at least has
 * gear on it, where an arch is *absence* shaped a particular way.
 *
 * So it is STEPPED rather than curved. A true soffit at this camera is a
 * half-tile radius drawn about fourteen pixels high, where an arc and a chamfer
 * are the same three grey pixels — and every curve in this renderer is a stack
 * of boxes anyway. Three corbels a side is what reads as a span; two reads as a
 * chamfer and four is noise.
 *
 * `ARCH_SPRING` is how far the masonry has closed in by the crown, per side, so
 * the narrowest the opening ever gets is `1 - 2 * ARCH_SPRING`. It is the number
 * to be careful with: past about a quarter the crown is narrower than the
 * doorway it is supposed to be grander than, and what that draws is a keyhole.
 *
 * `ARCH_RISE` is how far down the springing starts from the header. Deep, because
 * the header itself is thin — an arch reads as a span between two piers, and a
 * thick lintel with a token step under it reads as a doorway somebody has put a
 * bracket in.
 */
const ARCH_HEAD = 0.09;
const ARCH_RISE = 0.32;
const ARCH_SPRING = 0.22;
const ARCH_STEPS = 3;

/**
 * A RAILING: how many posts to a cell, and where the rail sits.
 *
 * The `stripes`/`tufts`/curtain argument for the fifth time — what survives of a
 * flat pattern across a room at 45° is its colour, so a rail drawn as a paler
 * band on a solid boundary is a fence painted two colours. What makes a railing a
 * railing is that you can SEE THE SHOP THROUGH IT, and that is geometry: gaps.
 *
 * Four posts to a cell against a cell that is a metre and a half is a post about
 * every 40cm, which is close-set for a real rail and the sparsest that still
 * reads as a barrier rather than as three sticks. `RAIL_POST` is a fraction of
 * that pitch, the way `CURTAIN_DUTY` is of a strip's.
 *
 * There are TWO rails, one at the top and one part way down, and `RAIL_AT` is
 * where the lower one sits as a fraction of the boundary's own height. Keep the
 * two clear of each other: at `RAIL_AT + RAIL_THICK / h` past `1 - RAIL_THICK / h`
 * they overlap into a solid band, which is a fence again — the one failure here
 * that draws as a perfectly good piece of a different kind.
 */
const RAIL_POSTS = 4;
const RAIL_POST = 0.24;
const RAIL_AT = 0.45;
const RAIL_THICK = 0.08;

/**
 * The stack of boxes one edge is built from, bottom to top.
 *
 * Lives here, beside the style it reads, because two things draw an edge now:
 * the shop, and the palette button offering to sell you one. A button that drew
 * its own idea of a window is a picture of a thing the game does not build —
 * and it would be a *convincing* picture, since nobody compares a 38px button
 * against a wall across the room. So the shape is derived once from the style
 * and both callers ask for it.
 *
 * `opening`, `glass` and `mark` stay the authored facts — "you can walk through
 * this", "you can see through this", "not everybody may" — and this is the one
 * place that turns any of them into geometry.
 */
export function edgeBands(style) {
  // A way through: a header across the top, a threshold underfoot, nothing in
  // between. A rule about who may use it rides on the threshold as a colour —
  // the band is the same band, so a signed door is the same geometry as a plain
  // one and nothing downstream had to learn a second shape.
  if (style.opening) {
    return [
      { y0: style.h - 0.16, y1: style.h },
      // Up FROM the deck rather than starting at the floor line, and the two are
      // not the same picture: a way through is cut in whatever the shop is
      // standing on, so a gate in a fence sits on grass at 0.01 and a doorway on
      // floor at 0.06. A band that began at the line would hang a finger's width
      // of air under every gate in the game. What had to clear the ground was
      // only ever the band's TOP face — the buried half of a solid box is
      // nobody's problem.
      // ...and it stops AT the line, which is the same lip a shopfront's kick
      // plate stops at — the two sit in the same wall a tile apart, so a stoop
      // that stood proud of it read as a step somebody had left in. A signed way
      // through keeps a little of the extra, because that stripe is the only
      // thing on screen saying who a door is for and it is being read edge-on.
      { y0: 0, y1: GROUND_LINE + (style.mark ? 0.03 : 0), color: style.mark },
    ];
  }
  // An arch: the opening's own two bands, with the span corbelled in from either
  // side under the header.
  //
  // Built out of the opening's bands rather than beside them, for the reason the
  // roller door's are: the head and the step are at the same heights, so an arch
  // in a painted wall takes the paint on the parts of it that are wall, and a
  // signed one puts its stripe exactly where a signed doorway puts it. What is
  // added is the springing — and unlike the shutter's gear, every course of it
  // carries NO colour of its own, because it is masonry. Paint an arched wall and
  // the arch is painted, which is the whole reason anybody builds one.
  if (style.arch) {
    const head = style.h - ARCH_HEAD;
    const spring = head - ARCH_RISE;
    return [
      { y0: head, y1: style.h },
      { y0: 0, y1: GROUND_LINE + (style.mark ? 0.03 : 0), color: style.mark },
      // Widest at the TOP, which is the way round an arch actually closes: the
      // opening is full width at the springing line and narrowest at the crown,
      // so the masonry grows as it rises. Drawn the other way you get a funnel,
      // which reads as a doorway with its jambs splayed.
      ...Array.from({ length: ARCH_STEPS }, (_, i) => {
        const len = ARCH_SPRING * ((i + 1) / ARCH_STEPS);
        const step = ARCH_RISE / ARCH_STEPS;
        return [-1, 1].map((s) => ({
          y0: spring + step * i,
          y1: spring + step * (i + 1),
          off: s * (0.5 - len / 2),
          len,
        }));
      }).flat(),
    ];
  }
  // A railing: posts up from the deck with a rail across them, and the gaps
  // between the posts are the piece. `off`/`len` place a band along the cell —
  // the same machinery a brick course and a curtain's strips already ride — so a
  // vertical member is a short band that happens to be tall.
  if (style.railing) {
    const pitch = 1 / RAIL_POSTS;
    const rail = style.h * RAIL_AT;
    return [
      // The rail first, so a run of them merges into one instanced mesh with the
      // rails of every other cell rather than alternating with posts.
      { y0: rail, y1: rail + RAIL_THICK, color: style.rail ?? style.color },
      { y0: style.h - RAIL_THICK, y1: style.h, color: style.rail ?? style.color },
      ...Array.from({ length: RAIL_POSTS }, (_, i) => ({
        y0: GROUND_LINE, y1: style.h, color: style.color,
        off: -0.5 + pitch * (i + 0.5), len: pitch * RAIL_POST,
      })),
    ];
  }
  // A roller door, up: an opening's header and threshold, with the coil hung
  // under the lintel and a track down each jamb.
  //
  // Deliberately built out of the opening's own two bands rather than beside
  // them — the head and the step are the same bands at the same heights, so a
  // roller door in a painted wall takes the paint on exactly the parts of it
  // that are wall, and a signed one puts its stripe where a signed doorway puts
  // it. What is added is the machinery, and every piece of that carries its own
  // colour, which is what keeps a finish off it.
  if (style.shutter) {
    const head = style.h - 0.16;
    const coil = head - SHUTTER_COIL;
    const rib = SHUTTER_COIL / SHUTTER_RIBS;
    const jamb = 0.5 - SHUTTER_TRACK / 2;
    return [
      { y0: head, y1: style.h },
      { y0: 0, y1: GROUND_LINE + (style.mark ? 0.03 : 0), color: style.mark },
      // The coil, inset so it sits BETWEEN the tracks rather than over them —
      // a roll running the full width would bury the top of each guide, and the
      // guides are half of what says "shutter" from a distance.
      ...Array.from({ length: SHUTTER_RIBS }, (_, i) => ({
        y0: coil + rib * i,
        y1: coil + rib * (i + 1),
        color: i % 2 ? PALETTE.shutterDeep : PALETTE.shutter,
        off: 0,
        len: 1 - SHUTTER_TRACK * 2,
      })),
      // ...and the two guides, which are the one thing in `edgeBands` that runs
      // UP a cell rather than across it. `off`/`len` place a band along the
      // wall, so a vertical member is simply a short band that is tall — no new
      // machinery, the same way the curtain's strips ride a brick course's.
      ...[-1, 1].map((s) => ({
        y0: GROUND_LINE,
        y1: head,
        color: PALETTE.shutterTrack,
        off: s * jamb,
        len: SHUTTER_TRACK,
      })),
    ];
  }
  // A curtain: a rail, and strips hanging off it that stop short of the deck.
  //
  // The inverse of an opening — the hole is at the bottom instead of the middle
  // — and it is the first edge whose bands do not span their cell. `off` and
  // `len` are how a brick course already says that, so the strips ride the
  // machinery that was there rather than teaching the renderer a second shape.
  if (style.curtain) {
    const drop = Math.max(GROUND_LINE, style.drop ?? CURTAIN_DROP);
    const head = style.h - 0.1;
    const pitch = 1 / CURTAIN_STRIPS;
    // Who it is for, on the rail. Under the rail rather than on it, because the
    // coping the renderer lays along the top of a capped run would sit right
    // over it — a mark you cannot see is the whole feature unmarked.
    const band = style.mark ? 0.05 : 0;
    return [
      { y0: head, y1: style.h },
      ...(band ? [{ y0: head - band, y1: head, color: style.mark }] : []),
      // ...and the strips hang off the BOTTOM of whatever that came to, rather
      // than off the rail. Run up to `head` regardless and they cover the mark
      // for most of the cell at exactly the same thickness — two coplanar faces,
      // one depth buffer, so which one you see depends on the camera. Same
      // artefact `GROUND_LINE` is written up for, a wall higher.
      ...Array.from({ length: CURTAIN_STRIPS }, (_, i) => ({
        y0: drop, y1: head - band, color: PALETTE.curtain,
        off: -0.5 + pitch * (i + 0.5), len: pitch * CURTAIN_DUTY,
      })),
    ];
  }
  // Glazed: sill, header, and a see-through band filling the gap. Where that gap
  // starts and stops is the only difference between a window, a shopfront, a bay
  // and a strip up under the lintel — so this is four looks in three numbers, and
  // the defaults ARE the window that has always been here.
  if (style.glass) {
    // Where the glass starts is authored, and where the ground stops is not the
    // author's business — a shopfront asks for its pane to come down as far as
    // it can, which is the deck as far as `GLAZING` is concerned and the floor
    // line as far as the renderer is. Clamped rather than re-authored, so the
    // number in `EDGE_STYLE` goes on saying what it means.
    const sill = Math.max(GROUND_LINE, style.sill ?? 0.34);
    const head = style.head ?? 0.9;
    const out = style.out ?? 0;
    return [
      { y0: 0, y1: sill },
      { y0: head, y1: style.h },
      { y0: sill, y1: head, alpha: GLASS, out, shadow: style.shadow },
      // A bay needs something to stand the glass on and something to cap it, or
      // the pane floats a hand's width off the front of the building. Only when
      // it projects: on a flush window these would be two slabs inside the wall.
      ...(out ? [
        { y0: Math.max(0, sill - 0.07), y1: sill, out },
        { y0: head, y1: head + 0.07, out },
      ] : []),
    ];
  }
  return [{ y0: 0, y1: style.h }];
}

/**
 * Where a hanging prop hangs.
 *
 * Read off the wall rather than written down again, because a pendant an inch
 * above the wall top pokes through the roof of a building that has no roof —
 * which on a 45° camera reads as a lamp floating outside the shop. Derived, so
 * restyling a wall taller takes the ceiling with it.
 *
 * `LIFT` is the half that was missing, and it only became visible once a
 * hanging prop could be put where you actually want one. A wall is 1.1 and a
 * head tops out at 0.96, so the "ceiling" was barely above standing height:
 * anything that hangs DOWN from it — a string of lights, a pendant on a flex —
 * arrived resting on top of the shelving it was bought to light. What that
 * reads as is the fitting being the wrong size, and it is the room being too
 * short. Lifted rather than making the walls taller, because wall height is the
 * whole silhouette of the building and this is a question about one prop kind;
 * the cost is that a fitting now sits above the wall line, which from a camera
 * looking into a roofless building reads as depth rather than as error.
 *
 * What sets the number is not the walls, though — it is the READOUTS. A unit
 * waiting for stock floats a thought bubble a little over its own top, so the
 * band just above the shelving is already spoken for, and a fitting hung into
 * it tangles with the one thing in the shop whose whole job is being legible at
 * a glance. So the ceiling clears that band rather than clearing the shelf.
 */
const LIFT = 0.8;
export const CEILING_Y = EDGE_STYLE[E.WALL].h + LIFT;

/** Slightly vary a colour per tile so big flat areas don't look dead. */
export function jitter(hex, amount, seed) {
  const n = ((Math.sin(seed * 12.9898) * 43758.5453) % 1 + 1) % 1;
  const d = (n - 0.5) * amount;
  const c = parseInt(hex.slice(1), 16);
  const r = clamp8(((c >> 16) & 255) + d * 255);
  const g = clamp8(((c >> 8) & 255) + d * 255);
  const b = clamp8((c & 255) + d * 255);
  return (r << 16) | (g << 8) | b;
}

const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * What colour one cell of a laid floor is.
 *
 * A pattern here is per-cell colour and nothing else — no geometry, no second
 * mesh, no texture. That is not a shortcut: the ground is seen edge-on at 45°
 * with a shop standing on it, so a repeat finer than one tile is invisible from
 * anywhere you actually play, while a colour that alternates tile by tile reads
 * from across the room. It also costs nothing, because the ground loop already
 * writes a per-instance colour to jitter it.
 *
 * Every pattern still jitters, at a lower amount than bare ground: a floor
 * somebody laid should read as laid rather than as grown, but a perfectly flat
 * sheet of one value looks like a hole in the render.
 *
 * `accent` defaults to a darkened `color`, so a one-colour floor is one field
 * and a chequerboard nobody gave a second colour to is still a chequerboard.
 */
/**
 * How many bars a striped cell is painted with, and how wide each one is.
 *
 * Three at a sixth of a tile is 50% duty, which is what a zebra crossing is.
 * The number matters less than the fact that it is sub-tile at all: every other
 * ground pattern in this game is one colour per cell (`patternColor`), because
 * at 45° across a room nothing finer survives — and that is true of a chequer
 * and false of a crossing. A bar the width of a whole tile is half a car long.
 */
export const STRIPE_BARS = 3;

/**
 * ...off the row where one says so, and the gap is always the bar.
 *
 * `STRIPE_BARS` is a fallback for a design that did not choose, the way
 * `FALLBACK_FIXTURE_COST` is a floor for a kind nobody priced — not a second
 * opinion. Duty is derived rather than authored: half-and-half is what makes a
 * zebra a zebra, so one number says everything about the marking.
 */
export const stripeBars = (surface) => Math.max(1, Math.round(surface?.bars || STRIPE_BARS));
export const stripeDuty = (surface) => 1 / (stripeBars(surface) * 2);

/**
 * How thickly an unauthored `tufts` cell is planted, and how tall a blade is.
 *
 * Six is enough to read as planted from the height you play at and cheap enough
 * to carpet a field with — see `MAX_TUFTS` in `client/render/scene.js` for the
 * ceiling this multiplies into. `STRIPE_BARS`' argument applies word for word: a
 * fallback for a design that did not choose, never a second opinion.
 *
 * It was four while a blade was a wide triangle, where four already looked
 * crowded. A blade is a narrow strip now and the same four read as bald, which
 * is the ordinary way a density and a shape have to be retuned together.
 */
export const TUFT_DENSITY = 6;
/** In tiles. A shopper is about 0.9 tall, so this is ankle-deep. */
export const TUFT_BLADE = 0.13;

export const tuftDensity = (surface) => Math.max(1, Math.round(surface?.density || TUFT_DENSITY));
export const tuftBlade = (surface) => Math.max(0.02, surface?.blade || TUFT_BLADE);

/**
 * A brick, in tiles, and the joint around it.
 *
 * STYLISED, and it has to be. A cell is about a metre and a half of shop, so a
 * real 215mm brick is a seventh of one and a 65mm course is a twentieth — which
 * at this camera, on a wall seen from across a room, is a line thinner than a
 * pixel. What you get for authoring the true size is a red smear, which is
 * exactly what a per-cell colour already gave us. So these are the biggest
 * bricks that still read as bricks: three and a bit to a cell, six or seven
 * courses to a wall, which is roughly the size the crates and the shelving are
 * drawn at and therefore agrees with everything standing in front of it.
 *
 * The joint is what makes it masonry rather than tiling — same argument as the
 * tufts: what survives at 45° is not the colour, it is that the wall has
 * TEXTURE, and the shadow in the joint is the whole of that.
 */
export const BRICK_W = 0.3;
export const BRICK_H = 0.16;
export const BRICK_JOINT = 0.022;

/**
 * ...and a TILE, which is the same idea with two numbers changed.
 *
 * Square and stacked rather than long and half-bonded, which is the whole of the
 * difference between the two patterns and the reason they are two patterns
 * rather than one with a flag: what you are choosing when you pick a finish is
 * "brick" or "tiling", and nobody wants to specify a bond. Everything else — the
 * proud course, the joint, the mortar underneath — is shared, because it is the
 * same claim about the same camera.
 *
 * The joint is FINER than a brick's. Grout is a couple of millimetres against a
 * brick's ten, and at this size the difference between them is one pixel — but
 * it is the pixel that says which one you are looking at.
 */
export const TILE_W = 0.22;
export const TILE_JOINT = 0.014;

/** Which bond a surface is laid in, or null if it is not laid at all. */
export function bondOf(surface) {
  if (surface?.pattern === 'brick') {
    return { w: BRICK_W, h: BRICK_H, joint: BRICK_JOINT, stagger: true };
  }
  if (surface?.pattern === 'tiles') {
    return { w: TILE_W, h: TILE_W, joint: TILE_JOINT, stagger: false };
  }
  return null;
}

/**
 * The bond — where every brick in one face goes.
 *
 * A pure list rather than geometry, because two things draw it: the wall, and
 * the palette button offering to sell you the tin. That is the rule the whole
 * of `client/thumb.js` rests on — a picture of a thing has to come from the
 * thing — and it is why `edgeBands` lives in this file rather than in the
 * renderer.
 *
 * THE BOND IS LAID ON THE WALL, NOT ON THE CELL, and that is the whole of this
 * function's difficulty. A face is one cell of a wall and is drawn on its own,
 * so the obvious version lays a whole number of bricks in each cell and closes
 * the staggered courses with a half brick at either end — which is a perfectly
 * good wall and has a joint running up it at **every cell boundary**, all the
 * way along, in every other course. What that draws is a wall built out of
 * panels: you can see where the segments meet, which is the one thing masonry
 * is supposed to hide, and it is worse the longer the run.
 *
 * So `phase` is where this face begins along its own wall, in tiles, and the
 * courses are laid on the infinite grid that implies. A brick that straddles a
 * boundary is CLIPPED rather than shortened, and the two halves — one drawn by
 * each cell — butt together with no joint between them, because the joint is
 * only ever inset at an end that is a real end of a brick. They take the same
 * colour, too: the jitter is seeded off the brick's own position on the wall
 * rather than off its position in the face, or a split brick comes out as two
 * slightly different reds and the seam is back in a subtler form.
 *
 * The trade this leaves is at a genuine stopped end — the last cell of a run, or
 * the reveal at a doorway — where a course now ends in a part brick. Which is
 * what a stopped end looks like anyway, and there is exactly one of them per
 * run rather than one per cell.
 *
 * @param bond   from `bondOf`: how big a brick is and whether courses stagger
 * @param len    how long the face is, in tiles (a cell, so 1, unless something
 *               is drawing a sample of it)
 * @param y0,y1  the band it fills, in tiles above the floor
 * @param phase  where the face starts along the wall, in tiles
 */
export function brickBond(bond, len, y0, y1, phase = 0) {
  const out = [];
  const { w: bw, h: bh, joint, stagger } = bond;
  const rows = Math.max(1, Math.round((y1 - y0) / bh));
  const h = (y1 - y0) / rows;
  // A whole number of bricks to the TILE rather than to the face, so the grid is
  // periodic on the lattice the walls themselves are on — otherwise a run of
  // twelve cells accumulates a fraction and the courses drift out of true with
  // everything else in the shop.
  const cols = Math.max(1, Math.round(1 / bw));
  const w = 1 / cols;
  for (let r = 0; r < rows; r++) {
    const b0 = y0 + r * h;
    const shift = stagger && r % 2 === 1 ? w / 2 : 0;
    // The first brick whose span can reach this face, on the global grid.
    const k0 = Math.floor((phase - shift) / w);
    for (let k = k0; (k * w) + shift < phase + len; k++) {
      const s = k * w + shift;
      const a = Math.max(s, phase);
      const b = Math.min(s + w, phase + len);
      if (b - a <= joint) continue;
      // Inset only where the brick really ends. A cut edge is left square, so
      // the half in this cell and the half in the next one meet as one brick.
      const cutA = a > s + 1e-6;
      const cutB = b < s + w - 1e-6;
      const x0 = a + (cutA ? 0 : joint / 2);
      const x1 = b - (cutB ? 0 : joint / 2);
      if (x1 - x0 <= 0) continue;
      out.push({
        // Centred on the face, because that is how a wall box is positioned.
        off: (x0 + x1) / 2 - phase - len / 2,
        len: x1 - x0,
        y0: b0 + joint / 2,
        y1: b0 + h - joint / 2,
        // The brick's own place on the wall, so both halves of a split one are
        // the same brick as far as anything downstream is concerned.
        seed: Math.round(s * 977 + b0 * 313),
      });
    }
  }
  return out;
}

export function patternColor(surface, x, z) {
  const base = surface.color;
  const accent = surface.accent ?? shade(base, -0.16);
  const alt = surface.pattern === 'checker'
    ? (x + z) % 2 === 1
    // Planks run along x and step every third row, so the joins stagger rather
    // than lining up into one long stripe down the shop.
    // `stripes` and `tufts` are deliberately absent, and they are the two
    // patterns that are not a per-cell colour. A zebra bar is a fraction of a
    // tile wide — one bar per CELL is a bar half a car long, which is a
    // chequerboard with ambitions — and a tuft is not flat at all. Both leave
    // the cell its base colour here and draw themselves on top of it as their
    // own geometry, in `accent`: see `STRIPE_BARS` and `TUFT_DENSITY` above,
    // and `addStripes` / `addTufts` in `client/render/scene.js`, which lay them.
    : (surface.pattern === 'planks' ? Math.floor(z + (x % 3 === 0 ? 1 : 0)) % 3 === 0 : false);
  // `brick` joins that pair, and inverts them: what the flat cell gets is the
  // ACCENT, because the flat part of a brick wall is the mortar and the bricks
  // are the thing standing on it. Authored the way you would say it out loud —
  // colour is the brick, accent is the joint — so the swap belongs here rather
  // than in whoever authors the row.
  //
  // Asked as `bondOf` rather than as `pattern === 'brick'`, and that is the whole
  // of the bug this line used to have. `tiles` is the second pattern laid in
  // courses and it was named here in neither half: the flat skin took the BASE,
  // so the grout came out the same colour as the tile it was grouting and the
  // authored `accent` moved nothing at all — a content column no row's value
  // could affect, which is the trap CLAUDE.md names about tiers, wearing a
  // surface. Nothing logs it and a tiled wall still looks tiled, because the
  // proud course keeps its own shadow. One question, so a third bond cannot
  // arrive with one of its two halves.
  if (bondOf(surface)) return jitter(accent, 0.02, x * 31 + z * 17);
  return jitter(alt ? accent : base, 0.03, x * 31 + z * 17);
}

/** A hex colour lightened (positive) or darkened (negative) by a fraction. */
export function shade(hex, by) {
  const c = parseInt(hex.slice(1), 16);
  const mix = (v) => clamp8(by >= 0 ? v + (255 - v) * by : v * (1 + by));
  return `#${(((mix((c >> 16) & 255) << 16) | (mix((c >> 8) & 255) << 8) | mix(c & 255)) >>> 0)
    .toString(16).padStart(6, '0')}`;
}

/** A shopper's face: calm cream, going hot and blotchy as their patience runs out. */
export const FACE_CALM = '#f6efe2';
export const FACE_ANGRY = '#d0503c';

/**
 * The flush, 0 (content) to 1 (about to walk out).
 *
 * Quantised, and that is the whole reason this is a lookup rather than a lerp:
 * `material()` caches by colour, so a continuous ramp would mint a fresh
 * material per shopper per frame and never reuse one. Eight shades are built
 * once and shared by everyone equally cross.
 */
const FACE_RAMP = Array.from({ length: 9 }, (_, i) => {
  const a = parseInt(FACE_CALM.slice(1), 16);
  const b = parseInt(FACE_ANGRY.slice(1), 16);
  const t = i / 8;
  const ch = (sh) => clamp8((((a >> sh) & 255) * (1 - t)) + (((b >> sh) & 255) * t));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
});

export const faceColor = (anger) => FACE_RAMP[Math.round(Math.max(0, Math.min(1, anger)) * 8)];
