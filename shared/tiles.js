/**
 * THE TILE VOCABULARY.
 *
 * Lives in shared/ because three places have to agree on it exactly: the
 * generator that writes tiles (`server/layout.js`), the validator that decides
 * whether you may build on one (`shared/build.js`), and the renderer that draws
 * them (`client/render/palette.js`). It used to live in server/layout.js with a
 * "keep this in sync" comment on the client copy, which is a promise rather
 * than a mechanism.
 */

/**
 * A tile is GROUND. What the floor is made of, and nothing else.
 *
 * It used to mean two things at once — what the floor is made of *and* what is
 * standing on it — which is why there was nowhere to put a rug. A rug is not a
 * floor material and it is not an occupant, and one cell holding one value has
 * no third answer. Fixtures are records in the layout's own lists now, and
 * whether a cell is occupied is `blocked`, derived from those lists.
 *
 * The numbers are deliberately not renumbered. `SHELF`, `FREEZER`, `CHECKOUT`
 * and `STATION` left, but a live save holds `tiles` as raw numbers and a
 * renumbering would silently turn every existing shop's floor into grass.
 * Gaps in an enum cost nothing; a migration nobody remembers to write costs a
 * shop.
 */
export const T = {
  GRASS: 0,
  FLOOR: 1,
  WALL: 2,
  // 3, 4, 5 were SHELF, FREEZER, CHECKOUT — now records, not ground.
  /** Dug earth. Still ground: a plot is what the floor is made of there. */
  PLOT: 6,
  DOOR: 7,
  PATH: 8,
  FENCE: 9,
  // 10 was STATION.
  /** The delivery pad in the yard: where a wholesale order lands as a pallet. */
  BAY: 11,
  /** The other pad in the yard: where you clear your hands. Its own ground
   *  rather than more bay, because the whole point of the split is being able
   *  to tell "this arrived" from "I put this here" at a glance. */
  DROP: 12,
  /** Where the staff go when they stop. The first pad that is not about goods:
   *  a bay holds crates and this one holds people, one per cell. */
  BREAK: 13,
  /** Out front: where a shopper who drove here leaves the car. The first pad
   *  that belongs to somebody who does not work here — a bay and a drop hold
   *  the shop's goods, a break area holds the shop's people, and this holds the
   *  people who came to buy. */
  PARK: 14,
  /**
   * The lane vehicles come in on. The first ground since `FLOOR` that is a
   * *look* rather than a job — the four pads above each say what happens on
   * them, and this one only says what it is made of.
   *
   * It is not a permission, and that is the whole of its design: `DRIVABLE` in
   * `server/layout.js` has always included grass, so every outdoor cell is
   * already a road and painting one takes nothing away. What it buys is that a
   * lane finder PREFERS it, so the way in is the way you drew rather than the
   * shortest line across somebody's lawn.
   */
  ROAD: 15,
  /**
   * A conveyor. The first ground that MOVES something, and the second after
   * `PLOT` that a fixture makes rather than a brush.
   *
   * It is ground for the same reason a bed is: a belt is not a thing standing
   * on the floor, it is what the floor is made of there — you walk over it, it
   * blocks nobody, and a run of twenty that owned its cells would be a wall
   * drawn through your own shop. `verify:catalog` asks every fixture to either
   * occupy its cell or be what the cell is made of, and this is the second
   * answer.
   *
   * The stamp is also what stops two belts landing on one cell. A non-blocking
   * fixture is invisible to `blocked`, so the only thing refusing the second
   * one is that `BUILDABLE_INDOOR` no longer holds what the first one made —
   * exactly how two plots have always refused to share a square.
   *
   * Which WAY it runs is not here and must never be: a tile holds one value,
   * and direction is a fact about the placement (`rot`), which is where every
   * other facing in the game already lives.
   */
  BELT: 16,
  /**
   * The paddock: the ground an animal is allowed to stand on.
   *
   * The fifth pad, and the first whose occupants are neither the shop's people
   * nor its goods. A bay holds crates, a break area holds staff, a car park
   * holds shoppers — and this one holds livestock, which is why it is a pad at
   * all rather than a look: painted ground with a job on it, and the job is
   * "how big you painted it is how many head it grazes".
   *
   * It is also the only fence this feature needs, and that is the decision
   * worth knowing. A paddock could have been the cells a flood finds inside
   * whatever fence you drew, which is what `computeIndoor` does for the shop —
   * and a gate left open would then mean the field is the entire map, re-asked
   * on every wall segment of every drag. Where an animal may stand is a fact
   * about the cell, so it is written on the cell. Draw a fence round it if you
   * want one; the rails are scenery and the paint is the rule.
   */
  PADDOCK: 17,
};

/**
 * Ground a walking character can stand on — before anything standing on it is
 * taken into account. Ask `isWalkableTile` in `shared/build.js` for the whole
 * question; this one only knows about the floor.
 */
export const WALKABLE = new Set([
  T.GRASS, T.FLOOR, T.DOOR, T.PATH, T.PLOT, T.BAY, T.DROP, T.BREAK, T.PARK,
  // Walkable, like every other pad. A paddock bounds where an ANIMAL may stand
  // and says nothing about anybody else — fencing the player out of their own
  // field would make a pen you cannot walk up to and collect from.
  T.PADDOCK,
  // Walkable, because a road is tarmac over grass you could always cross and
  // taking that away would mean a lane you paint can wall your own shop off.
  // Nothing in this game gets run over.
  T.ROAD,
  // Walkable for the same reason, said indoors: a belt laid down an aisle must
  // not be a wall, and a run you cannot step over would cut the shop in half
  // one cell at a time with no refusal anywhere to say so.
  T.BELT,
]);

/** Ground you can stand a shop fixture on — bare indoor floor and nothing else. */
export const BUILDABLE_INDOOR = new Set([T.FLOOR]);

/** Ground you can dig a farm plot into. */
export const BUILDABLE_OUTDOOR = new Set([T.GRASS]);
