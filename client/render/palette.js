/**
 * THE LOOK.
 *
 * Soft, flat-shaded pastels — the "tiny isometric shop" aesthetic. Every colour
 * in the game comes from here or from an item's own `model` JSON, so changing
 * the mood of the whole game is a one-file edit.
 *
 * THE ARCHITECTURE IS THE QUIET HALF, AND THAT IS A MEASUREMENT RATHER THAN A
 * TASTE. Colour is how a board of apples is told from a board of carrots across
 * the shop (see `GRADE.SATURATION` in look.js, which is only ever allowed to go
 * up) — so the goods are the loud thing and everything they stand on is not.
 * Counted: the 103 seeded items carry 304 colours at a median saturation of
 * 51%, and 202 of those 304 sit in hue 0–60, because food is warm. This file
 * has to be the ground that leaves them somewhere to be loud.
 *
 * It was not, and the way it failed is worth writing down because nothing in a
 * screenshot says it. The shop's own surfaces were warm too — floor at 65%
 * saturation on hue 40, which is MORE saturated than the median thing standing
 * on it — so the whole frame was one hue family and the goods had nothing to be
 * warmer than. What that reads as is a nice render that never quite becomes a
 * picture, and the instinct it provokes is to reach for the grade, which makes
 * it worse: turning everything up keeps the gap exactly where it was.
 *
 * The cel pass is what made it urgent. `BANDS = 3` deliberately collapses the
 * value ramp, so lightness stops being available to separate one surface from
 * another and hue has to carry nearly all of it — and there was only one hue
 * doing the carrying.
 *
 * So the rule, for anything added here: **the shop is lower-chroma than the
 * stock, and the GROUND is still warm.** Wood sits around 22–32% saturation at
 * hue ~30, walls and the smaller pads around 14–24% at hue ~38, and every
 * near-grey in the building is anchored COOL at hue ~215 rather than drifting —
 * road, park and railing each used to pick their own hue at 7–8% saturation,
 * which is three greys that disagree, and under banding three greys that
 * disagree is what reads as mud. Nature (grass, hedge, paddock) and the cold
 * fixtures (freezer, counter) keep their chroma: they are the counterweight,
 * not the ground.
 *
 * THE FLOOR IS THE EXCEPTION AND IT IS THE WHOLE LESSON. It was cut to 31% with
 * everything else and put back to 46%, which is still well under the 51% median
 * of the goods but a long way above the walls. The reason is that almost every
 * fixture in the shop is grey ALREADY — shelving, appliances, conveyors and
 * machines carry their own colours on their content rows, and those rows are
 * cool. So the architecture in this file is not what the eye actually reads as
 * the shop: the floor is the only large warm surface in frame, and taking its
 * chroma out did not open a gap, it left grey fixtures on grey ground under
 * grey walls with the goods as the only colour anywhere. Correctly diagnosed
 * and applied to the wrong surface — it read as a warehouse.
 *
 * What the frame wants is THREE layers rather than two: warm ground, cool
 * fixtures, saturated stock. The gap this file is responsible for is the one
 * between the floor and the goods standing on it, and the one between the floor
 * and the machinery bolted to it — not a uniform march downward. Before cutting
 * chroma anywhere here again, check what colour the CONTENT rows are: a surface
 * whose neighbours are already grey has no gap to open.
 *
 * Lightness is preserved exactly wherever this was applied. Every value below
 * that moved changed hue and saturation only, so nothing about which surface
 * reads as lighter than which — the thing the shadow rig and `SHADOW_FLOOR` are
 * tuned against — moved with it.
 */

import { T } from '../../shared/tiles.js';
import { E } from '../../shared/edges.js';

export const PALETTE = {
  /**
   * THE LAWN, WHICH IS THE LARGEST SINGLE COLOUR ANYBODY EVER SEES.
   *
   * It was the loudest thing in the frame and nothing about it had changed —
   * what changed is everything else. Quieting the shop's own surfaces left a
   * saturated mid-green covering half the screen as the one thing still shouting,
   * and `GRADE.SATURATION` at 1.22 is applied to it too, so it arrived on screen
   * louder than the goods it is supposed to sit behind. Goods are small and the
   * lawn is enormous, which is the whole argument: the same saturation reads as
   * a highlight at the size of a tomato and as a wall of colour at the size of a
   * field, so a big surface has to be lower-chroma than a small one to weigh the
   * same. Down from 47% to 31%, a touch darker, hue untouched.
   */
  grass: '#89b26c',
  grassAlt: '#7fa762',
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
  bay: '#d8cfc0',
  bayPlank: '#9e8266',
  /** The drop-off pad, where you park an armful. Half a step warmer than the
   *  bay, which is a hint rather than the answer — see above. */
  drop: '#ddd1bb',
  /** The break area: the one pad that is normally indoors, so it is the closest
   *  of the three to plain floor. */
  break: '#e3dac9',
  /** The car park: cold tarmac, and the darkest ground in the game on purpose.
   *  It is the one piece of hardstanding a customer sees before the shop, so it
   *  should read as the front of the building rather than as more of the back
   *  of it — the two yard pads are deliberately warm and light. */
  park: '#76808f',
  /** The paddock: the one pad that is not hardstanding at all. Grazed grass —
   *  greener and duller than the lawn beside it, which is the whole read. The
   *  four pads above are pale and warm because they are concrete you put things
   *  on; this one has to say "still a field, and something eats it". */
  paddock: '#9ab069',
  /** The road: darker than the car park it leads to, because the lane is the
   *  thing you drive on and the pad is the thing you stand on. Near-neutral on
   *  purpose — it is the longest run of one colour anybody will paint, so a
   *  road with any character in it would read as a stripe across the map. */
  road: '#5c6470',
  /** Last-resort bodywork — see `VEHICLE_LOOK`. Nothing on the road normally
   *  wears it: a vehicle row carries its own `color`, and its `model` carries
   *  the colours that actually get drawn. */
  vehicle: '#c9d1d9',
  floor: '#e8dac0',
  floorAlt: '#ddcbb0',
  wall: '#f7f6f4',
  wallTop: '#e4e1dc',
  shelf: '#a8896a',
  shelfTop: '#94775a',
  freezer: '#cfe6ea',
  counter: '#7fd4c8',
  station: '#9aa4b0',
  stationTop: '#cfd8e3',
  counterTop: '#66c2b5',
  path: '#d5c9b4',
  fence: '#b89674',
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
  railing: '#79808a',
  railingRail: '#a5abb3',
  door: '#f2f1ee',
  // The JOINERY round a way through: a jamb at each end of the opening and the
  // slice of lintel sat on them. It carries its own colour for the hedge's and
  // the railing's reason — a band with one is left bare by `buildEdges` — and
  // here that is the whole point rather than a side effect: a doorway is a
  // HOLE, so what says "there is a door here" is the frame, and a frame that
  // took the wall's finish would vanish again the moment somebody painted the
  // frontage the colour of the trim.
  //
  // WARM AND LIGHT, and that is a fact about the post pass rather than about
  // taste. `BANDS` is 3 (look.js), so the value ramp is collapsed to three
  // steps and a mid grey does not read as a mid grey — it falls to the bottom
  // band and draws as a near-black slab. Which is what a first pass at this in
  // the building's own cool near-grey (#6f7986) did: painted timber authored,
  // bollards rendered. So it sits a step under the wall rather than most of the
  // way to the ink, and it is warm, which is the one axis left to tell it from
  // the wall once lightness has been spent.
  doorFrame: '#c9bcab',
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

/**
 * THE LAND PAST THE LAST TILE — one palette per surround.
 *
 * Here rather than in `surround.js` beside the shapes, because this file is
 * where "changing the mood of the whole game is a one-file edit" is true and a
 * ring of buildings the size of the horizon is a large part of that mood. The
 * builder reads these and owns no colour of its own.
 *
 * EVERY COLOUR IN HERE IS DELIBERATELY DESATURATED against its equivalent
 * inside the lot, and that is distance rather than taste. There is no fog in
 * this scene — nothing pulls a far object back — so a backdrop mixed at the
 * same saturation as the shop competes with it, and what that reads as is the
 * horizon being closer than it is. Pulling the chroma out is the only depth cue
 * available, which is why the city greys are grey and the far trees are bluer
 * than `PALETTE.grass` rather than greener.
 *
 * `glowDay` / `glowNight` are the one pair that MOVES. They are the windows,
 * and `Scene.syncState` lerps between them on `daylight` — dark glass at noon,
 * lit at dusk. See `surroundGlow` there for why that material is owned rather
 * than taken from the shared `material()` cache.
 */
export const SURROUND_COLORS = {
  country: {
    /**
     * ★ THE LAND PAST THE LOT, which is the largest thing on screen and was the
     * last thing that did not know where the shop is.
     *
     * The apron runs 320 tiles in every direction, so a city shop stood in the
     * middle of a bright meadow with a skyline behind it — three bands of city
     * and one enormous field, which reads as the backdrop having been pasted on.
     * It is one colour rather than a texture because the apron is one flat
     * plane, and because a colour is the only thing about the ground that can be
     * changed without rebuilding the shop (see `Scene.recolourField`).
     *
     * IT STOPS AT THE FENCE. Everything inside the lot — bare cells and painted
     * ground alike — is what it always was, because that is the shop's own land
     * and the surround is a fact about the horizon. See `Scene.fieldColor`.
     *
     * DRY FIELD RATHER THAN LAWN, and this is the one of the three that moves an
     * existing shop: `country` is the default, so every save in the game was
     * standing on `PALETTE.grass` until this line. It is worth it because the
     * ridge, the woodland and the hedgerow are all green — the ground being
     * green too left the whole frame one colour, and stubble under green hills
     * is what farmland actually looks like from a distance. `PALETTE.grass`
     * itself is untouched: it is still what a painted lawn is made of, so the
     * two now read as a mown patch in a field, which is the right relationship.
     */
    ground: '#9a8d5e',
    /**
     * THE RIDGE, which is doing most of the work in every one of the three.
     *
     * The apron runs 320 tiles and the camera can only ever see about 19 of
     * them, so the lawn does not read as "a field" — it reads as a plane that
     * goes on for ever, which is the whole of "it looks alone". A raised band
     * ten tiles out is a STOP: the eye lands on it instead of running off, and
     * everything between it and the shop becomes ground rather than void.
     *
     * Two tones, and they are lighter than the lawn rather than darker. A ridge
     * darker than the grass in front of it reads as a shadow on flat ground; a
     * lighter, bluer one reads as being further away, which is the same trick
     * `blockFar` plays in the city and the only one available with no fog.
     */
    hill: '#7fb567',
    hillAlt: '#76a862',
    /**
     * ...and the FAR band, 38–130 tiles out, which is what you see when the
     * camera tilts down. Bluer and duller than the ridge for the reason the
     * ridge is bluer than the lawn — with an orthographic camera a distant
     * mountain is drawn exactly the size it would be up close, so colour is
     * doing all of the work that perspective normally does.
     */
    far: '#6f9c72',
    farAlt: '#668f6b',
    trunk: '#6b5540',
    // Two crowns rather than one. A ring of a single green is 48 copies of one
    // object however much the scatter varies their size, and the eye reads a
    // repeated colour faster than it reads a repeated silhouette.
    crown: '#5c8a52',
    crownAlt: '#4a7549',
    /** Hedgerow: lower, denser, and darker than anything standing on its own. */
    hedge: '#476b41',
  },
  suburb: {
    // Mown rather than meadow: a shade darker and a good deal less acid than the
    // countryside's, which is most of the difference between a lawn somebody
    // cuts and a field somebody grazes.
    ground: '#82b862',
    // Greener than the city's and greyer than the countryside's — a suburb is
    // the one of the three where the ridge is half built on.
    hill: '#84b46d',
    hillAlt: '#7aa76a',
    // The far band: distant hills with the town spilling over them, so greyer
    // than the countryside's and still green underneath.
    far: '#75986f',
    farAlt: '#6d8c69',
    // Four house colours, because a street of one is a housing estate rendered
    // in a single mesh and looks like one. They are close together on purpose —
    // a suburb is a repeated house, and the variation is meant to be noticed
    // only after the shape is.
    wall: '#cbbda8',
    wallAlt: '#bda893',
    wallWarm: '#c9a98f',
    wallCool: '#b6b3ad',
    /** Pitched roofs, which is the whole silhouette of a suburb. */
    roof: '#8d6a5c',
    roofAlt: '#7a5f57',
    trunk: '#6b5540',
    crown: '#5c8a52',
    /**
     * ...and the same house, standing ON the ridge — the town climbing the hill.
     *
     * Its own pair rather than the four above, and cooler and paler than any of
     * them, for the reason `hill` is lighter than the lawn: the ridge starts at
     * ten tiles and the haze does not begin until twenty-six, so nothing else
     * out there is going to say "further away" on this layer's behalf. Reusing
     * `wall` would stand a house on the hilltop in exactly the paint of one four
     * tiles from the fence, and the two bands would read as one distance.
     */
    ridgeWall: '#c2b6a6',
    ridgeWallAlt: '#b0a596',
    ridgeRoof: '#836961',
    /**
     * ...and one rooftop colour for the far band, which is the town seen from
     * far enough away that it is a colour rather than a house. Warm against the
     * green of the peaks and duller than either ridge tone, since this is the
     * one of the three that IS inside the haze ramp.
     */
    farRoof: '#84796f',
  },
  city: {
    // Hardstanding rather than verge: grey, with barely enough green left in it
    // to keep the per-cell jitter and the shadows readable — a dead neutral over
    // 320 tiles reads as an untextured plane rather than as ground.
    //
    // It is deliberately of a piece with `hill` below, because in a city the
    // ground and the thing the blocks are bedded into are the same stuff: the
    // seam at the edge of the lot is what says "the backdrop is a different
    // picture", and it is a seam right where the camera is looking. Lighter than
    // the ridge, so the ridge still reads as mass standing ON it.
    ground: '#9ba098',
    /**
     * The ridge a city stands on IS the city, so the terraces are made of the
     * same stuff the blocks are.
     *
     * They were grey-green — ground with the green pulled out of it — which is
     * the right answer for a hill a city happens to be standing on and the wrong
     * one for what this band is: at ten to twenty-four tiles the steps read as
     * mass, and green mass among grey blocks reads as hills that somebody
     * forgot to build on. Concrete, and a step DARKER than `block` below, so the
     * blocks standing on the terraces still come forward off them — the same
     * job `hillAlt` does against `hill`, done one layer up.
     */
    hill: '#7e8794',
    hillAlt: '#737c8a',
    // The far band is the city PROPER — the towers you never get to. Grey-blue
    // and deliberately the coldest colour in this file, since it is the one
    // thing meant to read as genuinely distant.
    far: '#7a8899',
    farAlt: '#6f7d8e',
    // Three greys climbing toward the blue of the sky, so a tall block reads as
    // further away than a short one without anything having to be further away.
    //
    // THESE ARE THE RIDGE NOW, not the near band. A city's built-up area is what
    // rises behind the shop, so the blocks moved out to stand on the hills and
    // the ground a stride from the fence became street furniture — the colours
    // did not have to move with them, because what they were always for was a
    // block seen against sky rather than a block seen against grass.
    block: '#8f96a3',
    blockAlt: '#7d8593',
    blockFar: '#98a2b0',
    /** The lip along the top of a block — the only detail at this distance. */
    parapet: '#6d7480',
    /**
     * ...and the near band, which is the one you stand next to.
     *
     * The only place in the three surrounds where a colour is read at arm's
     * length rather than across a field, so these are the only ones NOT pulled
     * toward the sky — a bollard hazed to look distant while it is four tiles
     * from the fence is just a grey bollard. Their job is the opposite one: to
     * hold their own against the shop's paint so the pavement reads as belonging
     * to the same street the building is on.
     */
    post: '#4f5661',
    bench: '#6d5a46',
    bin: '#4b5a53',
    kerb: '#9ba2a9',
    // Two, and only two: a row of parked cars in one colour is one car copied,
    // and the eye catches that before it catches anything else in the band.
    car: '#8d5f5a',
    carAlt: '#4f6b86',
    glowDay: '#5c6472',
    glowNight: '#ffd591',
  },
};

/** Player colours, cycled by join order. */
export const PLAYER_COLORS = ['#5b8ff9', '#f2a03d', '#7cc46a', '#c98ad9'];

/**
 * Full-height architectural edges, in world units.
 *
 * 2.1, up from the 1.4 it stood at since walls were buildable, and what
 * unlocked that is `Scene.hideNearWalls` rather than anything about the art. At
 * this camera pitch a wall conceals roughly `h / tan(pitch)` of the floor behind
 * it — so every centimetre of silhouette was a centimetre off the shop, and the
 * two faces nearest the viewer were spending it on the aisles you were trying to
 * look at. A building whose near walls come down pays that cost nowhere: the far
 * two are behind everything anyway, so height there is free and is the only
 * thing that makes the place read as a building rather than as a low pen.
 *
 * What measures off this is everything that is a fact about the WALL — a
 * window's head, a curtain's rail, the ceiling — so raising it is one number
 * rather than a retune, and a glazing goes on running up to the top of the wall
 * it is set in. Note which way round the two halves of a window are authored: a
 * SILL is a real height (waist, knee, shoulder) and stays absolute, while a HEAD
 * is "just under the lintel" and is written as `WALL_H - x`. The other way
 * round, raising the wall leaves a hand's width of brick above every window in
 * the shop.
 *
 * What does NOT measure off it is anything that is a fact about the person
 * walking through — see `HEAD_ROOM`. A doorway, a gate, an arch and a roller
 * door all keep their height and grow a thicker lintel, because a wall that
 * takes its openings up with it is not a taller building: it is the same
 * building with smaller people in it. That is the whole reason this number can
 * be moved at all, and the first thing to check if you move it again.
 */
const WALL_H = 2.1;

/**
 * The line an opening's head stops at: how tall a way through is, from the deck.
 *
 * `GROUND_LINE`'s mirror, and it exists for the same reason that one does — a
 * number the wall must not be allowed to decide. Every opening in this file used
 * to be written as `style.h - <a lintel's worth>`, which reads as "just under the
 * lintel" and is the same sentence a window's HEAD is written in (see `WALL_H`).
 * It is right about a window and wrong about a doorway, and the difference is
 * what the number MEANS: a window's head is a fact about the wall — glass runs
 * up to the top of it and a strip of brick above every pane is what a taller
 * wall should not leave behind — where a doorway's head is a fact about the
 * PERSON walking through, which no amount of masonry changes. Written the wall's
 * way, raising it by a hand's width raises every door, gate, arch and shutter in
 * the game by a hand's width, and what that draws is not a taller building: it
 * is a building at the same scale with a smaller person in it, which reads as
 * the characters having shrunk.
 *
 * So the wall grows and the hole does not — the lintel over it thickens instead,
 * which is what a taller wall over the same door actually looks like.
 *
 * 1.6 against a character who tops out at 1.32 (see `LIFT`) is a doorway about a
 * fifth again as tall as the people using it, which is roughly what a real one
 * is. It is also within a centimetre of the 1.59 every opening stood at when the
 * walls were 1.75, so this is a decoupling rather than a retune: nothing on
 * screen moved on the day it went in.
 *
 * `LINTEL` is the least masonry an opening is ever spanned by, and it is what
 * keeps this a CEILING rather than a height. A gate is cut in a fence half a
 * tile tall, so an absolute head would be a metre above the thing it is a hole
 * in — `headOf` takes the lower of the two, and every boundary shorter than a
 * wall goes on being spanned the way it always was.
 */
const HEAD_ROOM = 1.6;
const LINTEL = 0.16;

/**
 * Where an opening's head sits in a given edge: the head line, or as high as the
 * boundary can span it, whichever is lower.
 *
 * One function because four pieces ask it — a doorway, an arch, a roller door
 * and (through the arch) a signed one of each — and the four disagreeing is how
 * you end up with a shop whose doors are one height and whose arches are
 * another. `lintel` is how much masonry that piece needs over the hole: an arch
 * closes its own span in, so its header is thinner than a doorway's and the
 * corbels below it do the work.
 */
const headOf = (style, lintel = LINTEL) => Math.min(HEAD_ROOM, style.h - lintel);

/**
 * The line GLASS stops at, which is not the line an opening stops at.
 *
 * A pane runs as high as the wall lets it and leaves a lintel's worth of
 * masonry over itself, which is the `WALL_H - x` sentence being right — see
 * `WALL_H`. One constant rather than the same subtraction in four places,
 * because the four are now required to agree: a shopfront, a high window and
 * both glazed doorways all cap here, so a run of frontage with a door in the
 * middle of it draws as one band of glass rather than as three that nearly line
 * up. Nearly is the bad case — a two-centimetre step in a header reads as a
 * wall that has been built badly rather than as art that is out.
 *
 * A bay is the one glazing that does not use it, and says why in its own row:
 * it projects, so it wears a deeper head to cap the box it steps out into.
 *
 * `TRANSOM_BAR` is the solid member sat on the head of a fanlight, and it is
 * the whole difference between the two glazed doorways. Both are the same
 * regular doorway with glass in the band over it — the hole is a hole, and
 * nothing in this family ever draws glass across a way through — so what is
 * left to tell them apart is the frame. A bar under the pane reads as a
 * traditional light over a door; no bar, in a slimmer wall, reads as one sheet
 * of glass and is what "smooth" means here.
 *
 * Glazed cheeks down the two jambs were tried first and are gone. They drew
 * the shopfront door as a screen with a gap in it, which is a fair picture of a
 * real shop entrance and the wrong picture here: at this camera a pane a
 * twelfth of a tile wide either side of a doorway does not read as a frame, it
 * reads as glass across the opening — which is the one thing this whole family
 * must never look like, since the opening is walked through.
 */
const GLASS_HEAD = WALL_H - 0.08;
const TRANSOM_BAR = 0.06;

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
  [T.WALL]: { color: PALETTE.wall, h: WALL_H },
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
  // ...and a packer, which wears the same housing and swallows a crate the same
  // way. Missing, this is `undefined` and the piece is never added to the scene
  // at all — see the note on `under` below for what that costs.
  packer: { color: PALETTE.station, h: 0.78 },
  // ...and for a tunnel mouth. Missing, this is `undefined`, `plainBlock`
  // answers null and the fixture is never added to the scene AT ALL — no mesh
  // to raycast, so it cannot be pointed at, turned, bulldozed or shift-deleted,
  // and what stands in the shop is the rail loop with bare ground inside it.
  // `fixtureHeight` reads this to aim, which is what makes it the difference
  // between a piece you can get rid of and one you cannot.
  under: { color: PALETTE.station, h: 0.3 },
  // ...and the shaft, which is the tall one. `h` is what `fixtureHeight` aims
  // at, so a lift given the belt's 0.3 would be a column you can only point at
  // by clicking its feet.
  lift: { color: PALETTE.station, h: 1.3 },
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
  /** The walls of an overhead duct. Glass, because a run four metres up is
   *  between the camera and everything under it — the same argument the
   *  shopfront's glazing makes, said about a thing that hangs over the aisle
   *  you are trying to look at. It is the only part of the family that is not
   *  a grey: a duct has to read as enclosed from across the shop, and the pane
   *  is what says the box inside it is not simply floating. */
  glass: '#d6e9f4',
};

/**
 * THE TEAL A MACHINE WEARS, AND THE RUNG IT IS WEARING.
 *
 * Every machine in the family carries one accent — a loader's hood strip, a
 * sorter's cap, a mouth's lip — and it is the one part that is not a grey, so
 * it is what says "this is machinery" from across a shop full of pale plastic.
 * It also STEPS with the tier, which is the second job: the ladder is otherwise
 * invisible, because a Quick loader and a Maglev one are the same silhouette.
 *
 * These three hexes are already spelled in the authored `arm`, `sorter` and
 * `under` rows, one per stage. They are repeated here for the reason the rest
 * of `CONVEYOR` is: the derived half of the family cannot see those rows, and
 * a lift whose trim came from somewhere else is a machine standing in the run
 * wearing a colour nothing else in the run owns — which is exactly what it was.
 * Its frame borrowed the BELT's carrier (`#7f8d9e` and friends), a slate
 * blue-grey, so the one fixture that is all trim was the one fixture with no
 * teal on it at all, and it read as a duller, darker version of the accent
 * every machine beside it wears.
 *
 * Indexed by tier, so a shop with a fourth rung takes the last one rather than
 * going undefined — a mesh handed `undefined` is white.
 */
export const CONVEYOR_ACCENT = ['#3f9fb0', '#4fb3c4', '#63cddd'];

/** ...at a tier, clamped to what has been drawn. */
export const conveyorAccent = (tier) => CONVEYOR_ACCENT[
  Math.max(0, Math.min(CONVEYOR_ACCENT.length - 1, (tier ?? 1) - 1))
];

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
  // A doorway is a gap you can walk through: a header spanning the opening, a
  // threshold underfoot, and the joinery lining the hole — see `FRAME_JAMB`.
  door: {
    color: PALETTE.wall, top: PALETTE.wallTop, h: WALL_H, t: 0.17,
    opening: true, frame: true,
  },
  // A gate is the one opening with no frame on it, and that is a fact about
  // what it is cut in rather than an omission: a gate is a gap in a FENCE half a
  // tile tall, so its head is at 0.34 and a lined jamb would be a post as tall
  // as the panel beside it. What tells you where a gate is, is the fence.
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
    color: PALETTE.wall, top: PALETTE.curtainRail, h: WALL_H, t: 0.1, curtain: true,
  },
  // ...and a roller door is a doorway with the machinery drawn: the same header
  // and the same threshold, plus the coil that is the whole reason you can tell
  // it is one, and a track down each jamb. `color` is the WALL for the reason
  // the curtain's is — the lintel takes paint the way a window frame does, and
  // the slats carrying their own colour is what keeps a finish off galvanised
  // steel. Thicker than a plain wall (a shutter box stands proud of the
  // brickwork) and the tracks ride that thickness for free.
  shutter: {
    color: PALETTE.wall, top: PALETTE.wallTop, h: WALL_H, t: 0.2, shutter: true,
  },
  // ...and a window is a wall with a hole in the middle of it. `sill` and `head`
  // are where the glass starts and stops, and they are the WHOLE difference
  // between the four glazings — see `GLAZING` in shared/edges.js. Anything that
  // wanted a fifth look should be two numbers here and nothing else.
  glass: { color: PALETTE.wall, top: PALETTE.wallTop, h: WALL_H, t: 0.17, glass: true },
  // An arch is a doorway with the door left out and the span built in, so it is
  // the doorway's own base with one flag changed. Thicker, because the courses
  // that close the head in are a pier's worth of masonry rather than a frame's —
  // and the thickness is what makes the corbels read at 45°, since what you see
  // of a step is its top face.
  arch: { color: PALETTE.wall, top: PALETTE.wallTop, h: WALL_H, t: 0.22, arch: true },
  // A DOORWAY WITH GLASS IN THE WALL OVER IT. Two looks, one base — see
  // `WAY_LOOKS` in shared/edges.js for why that axis exists at all, and note
  // what is shared here: both are `opening: true`, so the hole itself is the
  // doorway's own hole and the threshold under it is the doorway's own
  // threshold. A signed one paints that step exactly where a signed doorway
  // paints it, and paint on the wall lands on the parts of it that are wall.
  //
  // `transom` is a fanlight: glass in the band between the head and the lintel,
  // which is `WINDOW_HIGH`'s band to the millimetre. That is not a coincidence
  // and it is the whole reason the head line is a constant — put one of these
  // in a run of high windows and the strip carries straight through it.
  glazedDoor: {
    color: PALETTE.wall, top: PALETTE.wallTop, h: WALL_H, t: 0.17,
    opening: true, transom: true, frame: true, bar: TRANSOM_BAR,
  },
  // ...and `shopfront` is the same doorway with the same glass over it and the
  // joinery slimmed down: no bar under the pane, and a frame thinner than the
  // masonry beside it (0.13 against 0.17). That is the whole of it, and it is
  // the whole of it on purpose — the pane runs from the head to the lintel in
  // one piece and lines up with the shopfront glazing either side, so a run of
  // frontage with one of these in the middle draws as a single band of glass.
  //
  // It keeps its JAMBS, and it is the piece that needed them most: a doorway is
  // a hole, and a hole cut in a wall of glass in the wall's own colour has
  // nothing round it to be a hole in. What it does not get is a head slice,
  // because there is no masonry over it to take one — the glass starts on the
  // head line. So the frame here is two posts under one unbroken pane, which is
  // what a modern shopfront entrance is.
  shopDoor: {
    color: PALETTE.wall, top: PALETTE.wallTop, h: WALL_H, t: 0.13,
    opening: true, transom: true, frame: true,
  },
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
  [E.WALL]: { color: PALETTE.wall, top: PALETTE.wallTop, h: WALL_H, t: 0.17 },
  [E.WINDOW]: EDGE_BASE.glass,
  [E.DOOR]: EDGE_BASE.door,
  [E.GATE]: EDGE_BASE.gate,
  // Glass to the lintel over a kick plate. `shadow` because a pane this size is
  // the *wall*: glass casts none by default, which is right for a bottle and a
  // freezer door and wrong for a shopfront — a building whose south face stops
  // laying a shadow on its own forecourt reads as the wall having gone.
  [E.WINDOW_FULL]: { ...EDGE_BASE.glass, sill: 0.05, head: GLASS_HEAD, shadow: true },
  // Standard glazing, pushed out over a sill. `out` is the one thing here that is
  // geometry rather than a pair of heights, and the renderer decides WHICH WAY out
  // is off the enclosure — a bay projects into the street, not into the aisle.
  [E.WINDOW_BAY]: { ...EDGE_BASE.glass, sill: 0.34, head: WALL_H - 0.15, out: 0.2 },
  // A strip up under the lintel, and it starts ON the head line rather than a
  // hand's width above it — see `HEAD_ROOM`. Both numbers used to hang off the
  // wall top (`WALL_H - 0.68`), which was right while nothing else in the wall
  // had an opinion about where the top of an opening is. Now something does:
  // the day a doorway stopped growing with the wall, a head at 1.6 and a sill at
  // 1.42 meant the strip started BELOW the door beside it and the two overlapped
  // by a hand's width — two openings in one wall disagreeing about their own
  // head line, which reads as one of them being misplaced and gives you no way
  // to tell which. Derived, so they cannot disagree again.
  // A strip up under the lintel. Light without a view, which is what you want on
  // a stockroom and on anything a passer-by should not be able to see the till
  // through.
  [E.WINDOW_HIGH]: { ...EDGE_BASE.glass, sill: HEAD_ROOM, head: GLASS_HEAD },
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
  // The glazed doorway, both looks, all four rules — derived off the two bases
  // rather than written out, so restyling a wall takes every one of them with
  // it and a signed one puts its stripe exactly where a signed doorway puts it.
  [E.DOOR_TRANSOM]: EDGE_BASE.glazedDoor,
  [E.DOOR_TRANSOM_STAFF]: { ...EDGE_BASE.glazedDoor, mark: PALETTE.markStaff },
  [E.DOOR_TRANSOM_IN]: { ...EDGE_BASE.glazedDoor, mark: PALETTE.markIn },
  [E.DOOR_TRANSOM_OUT]: { ...EDGE_BASE.glazedDoor, mark: PALETTE.markOut },
  [E.DOOR_SHOPFRONT]: EDGE_BASE.shopDoor,
  [E.DOOR_SHOPFRONT_STAFF]: { ...EDGE_BASE.shopDoor, mark: PALETTE.markStaff },
  [E.DOOR_SHOPFRONT_IN]: { ...EDGE_BASE.shopDoor, mark: PALETTE.markIn },
  [E.DOOR_SHOPFRONT_OUT]: { ...EDGE_BASE.shopDoor, mark: PALETTE.markOut },
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
 * A DOOR FRAME: how wide the jambs are, and how much of the lintel sits on them.
 *
 * A way through is drawn as an absence — a header over a threshold with nothing
 * in between — and that is a fine description of a doorway and a poor picture of
 * one. Set in a plain wall it is legible enough, because the hole is darker than
 * the masonry either side. Set in a SHOPFRONT it is not: the frontage is glass
 * at a third opacity in the wall's own colour, so the pane, the wall and the gap
 * are three shades of the same pale, and the entrance to the shop was the one
 * thing on the front of the building you could not find. Which reads as the door
 * not having been built rather than as art that is out.
 *
 * So the frame is what is added, and it is added the way the roller door's
 * tracks are: `off`/`len` bands running UP the cell rather than across it, so a
 * jamb is a short band that happens to be tall and the renderer learns nothing.
 * `FRAME_JAMB` is a hair narrower than `SHUTTER_TRACK` for the same argument
 * that sets that one — wide enough to see from across the shop, narrow enough
 * that the opening still reads as one.
 *
 * WHERE IT DIFFERS FROM THE SHUTTER'S TRACK IS THE ONLY INTERESTING PART, AND
 * IT WENT IN BACKWARDS FIRST. A track is drawn inside its own cell on purpose —
 * a roller door is gear, each cell has its own roll, so a two-cell bay is
 * honestly a pair of shutters. A doorway is the opposite claim: it is a HOLE,
 * and scene.js has said so since before there was a frame ("a doorway has no
 * jambs along its span"), which is why a run of them is spanned by one
 * continuous header with a pier only where two of them turn a corner. Lined
 * cell by cell, a three-cell shopfront entrance came out as four posts standing
 * in the gap — and at this camera, in the frame's own colour, what that draws
 * is not a wide door with mullions, it is a rank of bollards across the way in.
 * So a jamb stands at the END of a RUN, which is a fact about the neighbours and
 * therefore not a fact this file can know: the band says which side it is on and
 * `buildEdges` drops the ones with another framed opening beyond them.
 *
 * `FRAME_HEAD` is a slice off the BOTTOM of the header rather than a band added
 * under it, and that distinction is the whole care needed here. Every height in
 * this family is spoken for — the head line is a fact about the person walking
 * through (`HEAD_ROOM`), and a fanlight's glass starts exactly where a high
 * window's does (`GLASS_HEAD`, `TRANSOM_BAR`) so that a run of frontage with a
 * door in the middle draws as one strip. A lintel band that pushed either of
 * those up by its own thickness would put a two-centimetre step in a header,
 * which reads as a wall that has been built badly. Splitting the masonry that is
 * already there moves nothing at all: the hole stops where it stopped and only
 * the colour of its soffit changed.
 */
const FRAME_JAMB = 0.1;
const FRAME_HEAD = 0.09;

/**
 * What a frame looks like once somebody has PAINTED the wall it is set in.
 *
 * The hedge and the railing carry their own colours to keep the finish tool off
 * them, and the frame borrowed that rule and should not have. A hedge is a
 * planting and a railing is not a wall face; a door frame is joinery set in the
 * wall, and every real shopfront paints the two together. Left bare it read as
 * the paint having failed to reach — you paint the frontage, the header over the
 * glass turns and the frame does not, which points at the brush rather than at a
 * decision.
 *
 * So it takes the finish, one step down, and the step is what keeps this from
 * being the same sentence as "no frame at all". `-0.16` is `patternColor`'s own
 * default accent, which is the same distance a surface's second colour sits from
 * its first — so a painted frame is exactly as legible against its wall as a
 * chequer is against its floor, whatever colour the wall is painted.
 *
 * Down rather than up because that is the direction the unpainted pair already
 * runs (`doorFrame` is about this far under `PALETTE.wall`), so painting a shop
 * white leaves the frontage roughly where it started instead of inverting it.
 */
const FRAME_SHADE = -0.16;

/**
 * ...and it takes EITHER SPELLING OF A COLOUR, which is the one thing about this
 * seam worth knowing.
 *
 * Colour is a hex string nearly everywhere in this file and a packed int coming
 * out of `patternColor`, because `jitter` packs on the way past — and the caller
 * that matters here is the paint pass, so the natural-looking `shade(tone, ...)`
 * throws on the string method. What that costs is not one bad frame: `addEdges`
 * lays every boundary in the building in a single pass, so one throw inside it
 * is a shop with NO WALLS AT ALL, and the only thing on screen pointing at the
 * door frame is that the door frame is missing along with everything else.
 */
export function frameTint(color) {
  if (typeof color === 'string') return shade(color, FRAME_SHADE);
  const f = 1 + FRAME_SHADE;
  return (clamp8(((color >> 16) & 255) * f) << 16)
    | (clamp8(((color >> 8) & 255) * f) << 8)
    | clamp8((color & 255) * f);
}

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
    const head = headOf(style);
    // The JOINERY lining the hole: a jamb up each side of it, and — where there
    // is masonry over the opening to take one — the bottom slice of the header
    // sat on them. See `FRAME_JAMB` for why an absence needed drawing at all,
    // and note that both halves come off heights that already existed: the jamb
    // runs deck to head line and the head slice is cut out of the lintel, so
    // nothing in this family moved a millimetre when the frame went in.
    //
    // They carry their own colour, which keeps the finish tool off them — you
    // paint a wall, and the frame set in it is the thing that goes on saying
    // where the door is whatever colour you paint round it.
    //
    // ...and where there is NO masonry over the opening to take a slice out of,
    // the head member hangs UNDER the glass instead. Which is the shopfront
    // door: its pane starts on the head line, so there is nothing above the hole
    // to colour, and a frame that answered "no rail then" drew a sheet of glass
    // sitting on air between two posts. Downward rather than upward, because
    // every height above the head line in this family is spoken for — the pane
    // starts exactly where a high window's strip starts (`GLASS_HEAD`), so a
    // rail that pushed it up by its own thickness would put a step in a run of
    // frontage that is meant to draw as one band of glass. And it is honest
    // besides: this is the DOOR's top rail, and a door's top rail is under the
    // opening head rather than over it.
    const rail = style.frame && style.transom && !style.bar ? FRAME_HEAD : 0;
    // `jamb` is which END of the cell this one stands at, and it is the whole
    // reason the band carries a field nothing here reads: a run of doorway is
    // ONE opening, so the jambs between its cells have to go. That cannot be
    // decided in this file — an edge does not know its neighbours — so the band
    // says which side it is and `buildEdges` drops it when the cell that way is
    // another framed opening. See the jamb pass in scene.js.
    const jambs = style.frame ? [-1, 1].map((s) => ({
      y0: GROUND_LINE,
      y1: head - rail,
      color: PALETTE.doorFrame,
      off: s * (0.5 - FRAME_JAMB / 2),
      len: FRAME_JAMB,
      jamb: s,
      trim: true,
    })) : [];
    // GLAZED, which is the same opening with the masonry over it replaced by a
    // pane — see `EDGE_BASE.glazedDoor`. Built out of the plain doorway's bands
    // rather than beside them, for the reason the shutter's and the arch's are:
    // the head and the step are at the same heights, so one of these in a run of
    // doorways lines up with them and a signed one puts its stripe where a
    // signed doorway puts it.
    //
    // The glass replaces the HEADER and never the hole. That is the one rule in
    // this family and it is the shutter's own "there is no shut one": a pane
    // drawn across a way through would be a kind the table calls passable and
    // the picture calls solid, arriving as a shopper walking through plate
    // glass and looking entirely deliberate while it did.
    if (style.transom) {
      // Capped rather than run to the top, so the coping has masonry to sit on
      // and the frontage reads as one band of glass under one lintel — see
      // `GLASS_HEAD`. Guarded, because a glazed opening authored on a boundary
      // too short to carry one would otherwise emit a band of negative height,
      // which draws as a sliver at the wrong end of the wall.
      const cap = Math.min(GLASS_HEAD, style.h - 0.06);
      // The bar a fanlight sits on, and the one thing separating the two looks
      // — see `TRANSOM_BAR`. It is inside the glazed band rather than under the
      // head, or it would be a low rail across the way through.
      const sill = Math.min(cap, head + (style.bar ?? 0));
      return [
        { y0: cap, y1: style.h },
        // The bar IS this family's head slice — it is already a solid member sat
        // on the head line, so a framed one is the same band in the frame's own
        // colour rather than a second one under it. Which is what keeps the
        // fanlight starting where a high window's strip starts: add a slice here
        // and the glass over every glazed door in the shop steps up out of line
        // with the glazing either side of it.
        ...(sill > head ? [{
          y0: head,
          y1: sill,
          ...(style.frame ? { color: PALETTE.doorFrame, trim: true } : {}),
        }] : []),
        // ...or the rail hung under the pane, where there was no bar to be it.
        ...(rail ? [{ y0: head - rail, y1: head, color: PALETTE.doorFrame, trim: true }] : []),
        ...(cap > sill ? [{ y0: sill, y1: cap, alpha: GLASS }] : []),
        { y0: 0, y1: GROUND_LINE + (style.mark ? 0.03 : 0), color: style.mark },
        ...jambs,
      ];
    }
    // Where the masonry stops being frame and starts being wall. A slice off
    // the BOTTOM of the header rather than a band added under it — see
    // `FRAME_HEAD` — so the hole stops exactly where it stopped and only the
    // colour of its soffit changed. Clamped, because an opening cut in a
    // boundary too short to carry a slice would otherwise emit a header of
    // negative height.
    const soffit = style.frame ? Math.min(style.h, head + FRAME_HEAD) : head;
    return [
      ...(soffit > head
        ? [{ y0: head, y1: soffit, color: PALETTE.doorFrame, trim: true }] : []),
      // The header runs from the head line to whatever the wall came to, so it
      // is the LINTEL that grows with the wall and never the hole — see
      // `HEAD_ROOM`. One band either way, so a taller shop cost nothing here.
      { y0: soffit, y1: style.h },
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
      ...jambs,
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
    // The crown is the head line, the same as a doorway's — an arch is a grander
    // way through the same wall, not a taller one, and two pieces you can swap
    // between for free must not be two different holes. What a taller wall buys
    // an arch is the pier over it, which is exactly what an arch wants.
    const head = headOf(style, ARCH_HEAD);
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
    // The head line, for the reason the doorway's is — and it matters twice
    // over here, because the coil hangs off it and the tracks run up to it. Left
    // on the wall top, a taller shop would leave the roll and the guides drawn
    // over a hole nothing has to duck under, which is a shutter that has been
    // scaled up rather than a wall that has grown.
    const head = headOf(style);
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
    // The one head in this file that is still measured off the wall, and it is
    // not an oversight: a curtain's hole is at the BOTTOM (`drop`, absolute), so
    // a taller wall lengthens the strips and leaves what has to pass under them
    // exactly where it was. Pinned to `HEAD_ROOM` instead, the rail would come
    // down and the wall above it would simply not be drawn — a strip curtain
    // with a gap over it, which is a partition you can see the stockroom
    // through.
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
    const head = style.head ?? 1.2;
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
 * hanging prop could be put where you actually want one. A wall was 1.4 then
 * and a head topped out at 1.32, so the "ceiling" was barely above standing
 * height:
 * anything that hangs DOWN from it — a string of lights, a pendant on a flex —
 * arrived resting on top of the shelving it was bought to light. What that
 * reads as is the fitting being the wrong size, and it is the room being too
 * short. Lifted rather than making the walls taller, because wall height is the
 * whole silhouette of the building and this is a question about one prop kind;
 * the cost is that a fitting now sits above the wall line, which from a camera
 * looking into a roofless building reads as depth rather than as error.
 *
 * The walls DID grow in the end (see `WALL_H`), and this still stands rather
 * than being folded back into them: what made the room short was the gap
 * between the shelving and whatever hangs over it, and that gap is a fact about
 * props. A ceiling that is only the wall top is one where the two are the same
 * plane again the next time either moves.
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
