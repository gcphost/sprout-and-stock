/**
 * BUILD RULES — where a fixture is allowed to go.
 *
 * Shared on purpose. The client needs this to colour the ghost red or green
 * sixty times a second, and the server needs it to be the authority on what
 * actually lands. If those two ever disagree the ghost lies to you, so there is
 * exactly one copy of the rules and both sides import it.
 *
 * Everything here is a pure function of `layout` + a placement spec. No content,
 * no game state, no money — those live on the server side of the fence.
 */

import { T, WALKABLE, BUILDABLE_INDOOR, BUILDABLE_OUTDOOR } from './tiles.js';
import {
  E, SOLID, RULED, edgeBetween, reachable, withEdge, computeIndoor, shopperCanCross,
} from './edges.js';

/**
 * What each buildable thing is. `anchor` is the tile you have to be able to
 * stand on to use it — a shelf you can't reach is scenery.
 *
 * This is the closed set, and it is closed on purpose: a kind is a set of
 * placement rules, which is behaviour, and behaviour lives in a file that can be
 * reviewed and diffed. What is *not* closed is how many designs name into one —
 * see `shared/pieces.js`. Kinds are code; pieces are content, and unlimited.
 *
 * `blocks` is the whole difference between the two halves below, and it is a
 * field you can read rather than a tile enum you have to be a member of. A
 * shelf owns its cell and pathing routes round it; a rug, a planter or a
 * hanging lamp sits in the cell without owning it. That used to be expressible
 * only as "which set is this tile value in", which is not something content —
 * or a second thing on the same cell — could ever reach.
 *
 * `ground` is the other half: a plot doesn't stand on the floor, it *is* the
 * floor, dug. So it changes what the cell is made of and blocks nobody.
 *
 * `behind` is the second working spot, and only a till has one. Everything else
 * in this table is used from ONE side by ONE person: a shopper browses a shelf,
 * a worker loads an appliance, and the far side is the back of the unit. A
 * counter is used from both sides at once, by two different people, and the
 * shop only works when both of them can stand where they need to.
 *
 * `ends` is a *softer* claim than either, and the difference is what it is FOR.
 * `anchor` is the spot the generator reserves, floods for reachability and
 * routes a walk to — one tile, chosen when the thing was laid, and everything
 * that has to agree on a single answer reads it. `ends` says you can also work
 * the unit from either END of it, which is simply true of a shelf and of a
 * machine and is nobody's decision: you walk up to the side of a display unit
 * and put a loaf on it, and the shop refusing that is the shop being wrong
 * about its own furniture.
 *
 * So it deliberately changes only *reach* and what the markers draw. Widening
 * `anchor` would mean the generator reserving three tiles per shelf and
 * `canPlace` accepting a unit whose front is walled in, which is a different
 * and much larger change to what a shop is allowed to look like.
 *
 * A till has no `ends` on purpose. Its two spots are ROLES — one for the person
 * being served and one for the person serving — and a third tile at the end of
 * the counter is neither of those; it is somebody standing at the side of a
 * till, which is not a thing anybody does.
 *
 * The BACK is a fact about the piece rather than the kind, and it is the one
 * piece of this that content owns: `open` on a `fixtures` row, or on one of its
 * tier rungs — `openOf` in `shared/pieces.js` resolves the two. A shelving unit
 * has a back panel and a produce table has four legs, and those are the same
 * kind wearing two shapes — so which of them you can walk all the way round
 * cannot be answered here. It is deliberately NOT a variant: a variant is a look
 * and may never move a number, and how many sides a unit can be worked from
 * moves how a shop flows. A rung may buy it for the mirror-image reason — that
 * is exactly the kind of number a tier is supposed to move. See `spotsOf`.
 *
 * It was hardcoded as `{ x: till.x, z: till.z - 1 }` in `server/sim/staff.js`
 * before it was a field — "one tile north", which is right for exactly the
 * facing the generator happens to use and wrong for the other three. Turning a
 * till sent the clerk to a wall, or to a shelf, or onto the head of the queue,
 * and nothing refused the rotation because nothing knew the spot existed.
 * `anchor` was validated, reserved, drawn under the ghost and flooded for
 * reachability; this one was a literal in a job function.
 */
export const FIXTURES = {
  shelf: { label: 'Shelf', blocks: true, where: 'indoor', rotates: true, anchor: 'browseAt', ends: true },
  freezer: { label: 'Freezer', blocks: true, where: 'indoor', rotates: true, anchor: 'browseAt', ends: true },
  /**
   * The hot counter — a freezer pointed the other way, and the third and last
   * thing a unit of shelving can be.
   *
   * Every field on this row is a copy of the freezer's, which is the argument
   * for it being a kind at all rather than a field on the `fixtures` piece: the
   * two are identical in the things a kind decides — where it may stand, which
   * side you browse it from, whether you can walk round the back. What they
   * disagree about is WHAT MAY GO ON IT, and that is read off `shelf.kind`
   * everywhere in the sim. A `keeps: 'hot'` column on the piece would mean
   * every one of those sites resolving a placement back to its catalog row to
   * ask a question the placement already had the answer to.
   *
   * The kitchen is why it exists. Raw `chicken` is `needs-freezer` and the
   * `roast-chicken` it becomes required nothing at all, so the shop took
   * something out of a freezer, cooked it, and stood it on a wooden shelf next
   * to the bread — for as long as there had been a kitchen. `needs-warmer` is
   * the other half of a tag that was only ever written down cold.
   */
  warmer: { label: 'Hot Counter', blocks: true, where: 'indoor', rotates: true, anchor: 'browseAt', ends: true },
  checkout: {
    label: 'Till', blocks: true, where: 'indoor', rotates: true,
    anchor: 'serveAt', behind: 'tendAt',
  },
  station: { label: 'Appliance', blocks: true, where: 'indoor', rotates: true, anchor: 'useAt', ends: true },
  plot: { label: 'Plot', blocks: false, ground: T.PLOT, where: 'outdoor', rotates: false, anchor: null },
  /**
   * The bin — the first thing in the game that takes goods OUT of it.
   *
   * Until now stock had exactly two exits: somebody bought it, or it rotted.
   * There was no way to be rid of anything on purpose, which is felt hardest at
   * the two moments the shop is already going wrong — a line nobody wants, and
   * a harvest of the crop you had just stopped growing. `dropGoods` is the only
   * answer the game had, and a crate in the yard is not getting rid of
   * something, it is moving it.
   *
   * `where: 'any'` because rubbish goes out the back, and the back of the shop
   * is outdoors. Blocking, because it is a skip and you should have to put it
   * somewhere; `useAt` because it is used from one side like an appliance
   * rather than browsed like a shelf.
   *
   * **A kind rather than a `bin: true` on a piece**, for the reason the hot
   * counter's note gives at length: what may be done AT it is read off
   * `fixture.kind` in the sim and in `actionAt`, and a column on the catalog row
   * would mean every one of those sites resolving a placement back to its row to
   * ask something the placement already knew.
   */
  bin: { label: 'Bin', blocks: true, where: 'any', rotates: true, anchor: 'useAt' },
  /**
   * The conveyor — the first thing in the shop that moves goods without anybody
   * walking, and the first fixture since the plot that IS the ground.
   *
   * `blocks: false` with a `ground` is the plot's shape and it is load-bearing
   * twice. A belt run is twenty cells; owning them would draw a wall through
   * your own aisle and fire `canPlace`'s stranding warning on every cell of the
   * drag. And because a non-blocking fixture is invisible to `blocked`, the
   * tile stamp is the ONLY thing refusing a second belt on the same square —
   * `T.BELT` is in NEITHER buildable set, exactly as `T.PLOT` is not in
   * `BUILDABLE_OUTDOOR`, which is how two beds have always refused to share.
   * Both sets matter now rather than just the indoor one: see `where` below.
   *
   * `where: 'any'` — either side of the wall, on floor or on grass. It was
   * `'indoor'`, which is the shelf's rule borrowed by something that is not
   * shelving, and it is wrong about the one journey a conveyor most obviously
   * replaces: the walk from the yard. A dock is outdoors, the bay is outdoors,
   * and a run that had to begin inside the building could not be pointed at
   * either — so the machine that exists to stop hires crossing the shop was
   * refused at the exact end of the trip that is longest. Nothing about a belt
   * wants a roof; it is ground with a direction on it.
   *
   * It also takes conveyors out of `whatThisUnroofs`, which is the half you
   * would otherwise find later: a run that legitimately leaves the building
   * would warn "that leaves a belt standing outside" on every wall segment of
   * every drag, and a warning that fires whatever you do is one nobody reads.
   *
   * Pads and roads are still refused, and deliberately — `BUILDABLE_OUTDOOR` is
   * bare grass, so painting a bay does not stop being a bay because you ran a
   * line over the corner of it. Lay the run alongside and let a loader reach in.
   *
   * `anchor: null` because there is no side you work a belt from. A crate is
   * lifted off it the way a crate is lifted off anything — by pointing at the
   * crate — and the belt itself is only ever aimed at in build mode.
   *
   * `rotates` is the whole feature. A belt hands its crate to whatever it
   * FACES, so a belt pointing east feeding one pointing north is a corner: no
   * corner piece, no turn logic, and bends, tees and loops all fall out of one
   * field that already existed.
   */
  belt: {
    label: 'Belt', blocks: false, ground: T.BELT, where: 'any', rotates: true, anchor: null,
    // Which cells it moves goods BETWEEN, as quarter turns off `rot`. Its own
    // field rather than `anchor`, and the split is the whole point: `anchor` is
    // a tile the GENERATOR RESERVES, so saying it here would keep clear the very
    // square the next belt has to stand on. This one reserves nothing and is
    // read by the ghost only.
    //
    // It exists because without it these two kinds had no side markers at all —
    // `workSpots` is keyed off `anchor`, so a belt previewed as a bare tile and
    // the one thing a belt IS about, which way it runs, was the one thing the
    // preview could not tell you.
    flow: { out: 0 },
  },
  /**
   * The arm — a pair of hands bolted to the floor.
   *
   * It takes from the cell BEHIND it and gives to the cell in FRONT, which is
   * one rule covering every pairing an inserter has ever had. Blocking, because
   * it is a machine and should cost you the square.
   *
   * `anchor: null`, which is the plot's answer and is a correction rather than
   * an omission. An `anchor` is a tile the generator RESERVES, and the only two
   * tiles an arm cares about are the ones it works between — so an arm with a
   * `useAt` would reserve the very square the belt or the shelf it feeds has to
   * stand on, and the shop would keep its own conveyor from being finished. It
   * holds nothing between ticks, so there is also nothing to empty by hand.
   *
   * What it is NOT is a hire. It never chooses a shelf — you aimed it — so it
   * asks none of the shop's judgement rules except the one that exists for
   * unattended loops. See docs/belts.md step 2.
   */
  /**
   * The loader — a belt cell that also talks to what is beside it.
   *
   * It stands IN the run rather than next to it, which is the whole design and
   * a correction to two versions that did not. A machine on its own cell means
   * two parallel rows to stock one row of shelving — a lane of belt and a lane
   * of arms — which is twice the floor, twice the money, and a geometry puzzle
   * at every unit. Inline, a run is one row: crates flow along it and each
   * loader drops off whatever the shelf beside it will take.
   *
   * So it is a belt in every structural respect — non-blocking, stamps `T.BELT`,
   * has a facing, hands on to whatever it faces — and does one extra thing per
   * swing. `works` is what the placement warning reads: a loader with no
   * shelving beside it is an expensive belt.
   */
  arm: {
    // BLOCKS, unlike the belt it stands in, and it is the one of these three that
    // does. A run is ground you walk over — that is the whole of what `T.BELT`
    // buys and why a belt down an aisle is not a wall. A loader stopped being
    // ground the day it became a housing the track goes INTO: it is waist-high,
    // it swallows the crate, and a shopper strolling through it is the thing you
    // can see rather than a rule anybody has to know. The tile stays `T.BELT`,
    // so this is `blocked` doing the refusing for the first time on a conveyor
    // — and both still say no to a second piece on the square.
    label: 'Loader', blocks: true, ground: T.BELT, where: 'any', rotates: true, anchor: null,
    flow: { out: 0 },
    works: true,
  },
  /**
   * The sorter — the first conveyor cell with TWO ways out.
   *
   * Structurally a belt again: non-blocking, `T.BELT`, in the run rather than
   * beside it, straight-on derived exactly as a loader's is. What it adds is a
   * BRANCH, and `rot` is that branch — the same inversion `arm` made and for the
   * same reason. A sorter's straight-on is the boring half and derives fine from
   * the run it is standing in; the side you want it to divert down is the half
   * you actually have an opinion about, so that is the one the R key sets.
   *
   * It sorts by DESTINATION rather than by a filter, which is the decision worth
   * arguing. docs/belts.md step 3 proposed a tag on the fixture — `frozen` down
   * one branch, `produce` down the other — and that is authorable, predictable
   * and a thing you have to maintain: every item you add is a filter you have to
   * remember to widen, and a filter that has fallen behind your catalogue is a
   * line that quietly stops carrying half your stock. The run already knows what
   * is down it (`conveyorServes`), the shop already has one rule for whether a
   * unit will take something (`shelfAccepts`), and asking those two is a sorter
   * that is right about an item authored this afternoon.
   *
   * With no answer it SPLITS — alternate ways out, which is the same piece doing
   * the other job people want from a junction, and what `auto: false` pins it
   * to. A mixed crate splits too, for the reason step 3 gives: a box of carrots
   * and eggs pointed at a rule about carrots has no correct direction, and
   * answering for the biggest pile is the chevron bug wearing a filter.
   */
  sorter: {
    // ...and the same again, for the same reason: it wears the same housing.
    label: 'Sorter', blocks: true, ground: T.BELT, where: 'any', rotates: true, anchor: null,
    flow: { out: 0 },
    works: true,
  },
  /**
   * The underground — two mouths and a span that belongs to NOBODY.
   *
   * Structurally a belt again, and deliberately so: non-blocking, `T.BELT`, a
   * facing, hands on to what it faces. The one thing it adds is that what it
   * faces may be four cells away instead of one.
   *
   * A bridge was the other shape and it is wrong here. A belt is `blocks:
   * false`, so shoppers already walk over a run — a walkway would sell
   * permission that was never withheld. What is actually scarce is the SQUARE,
   * and this is the only piece that gives one back: the cells between two
   * mouths stamp nothing, reserve nothing and take no walk grid, so you floor
   * them, stand a shelf on them, and cross a second tunnel over them. A
   * crossing is two spans overlapping and needs no code that knows what a
   * crossing is, because a span is not a place.
   *
   * ENTRY AND EXIT ARE THE SAME PIECE, told apart by what is in front of them
   * (`tunnelExit`). Both are laid facing the way the goods go, and the upstream
   * one is whichever has the other one ahead of it. That is a derivation rather
   * than a stored partner id on purpose: `repositionFixture` names every field
   * it keeps, so a stored pair would be cleared by the one press most likely to
   * follow laying one — **R** — and what you would watch is a tunnel that works
   * until you straighten it.
   */
  under: {
    label: 'Underground', blocks: false, ground: T.BELT, where: 'any', rotates: true, anchor: null,
    flow: { out: 0 },
  },
  /**
   * Decorations. Both stand in a cell and neither blocks it.
   *
   * Deliberately NOT the authored-`blocks` kind the design doc describes. A
   * barrel that stops nobody is a lie you can see; a barrel that stops people
   * needs a tile stamp, and a tile can only say one thing at a time — which is
   * the whole reason step 5 exists. Until a cell can hold a list, "prop" means
   * "you walk past it", and that is true of everything below.
   */
  'prop-floor': { label: 'Decoration', blocks: false, where: 'any', rotates: true, anchor: null, at: 'floor' },
  'prop-ceiling': { label: 'Hanging', blocks: false, where: 'indoor', rotates: true, anchor: null, at: 'ceiling' },
};

/**
 * The kinds that are GROUND rather than something standing on it, which is why
 * none of them is in `FIXTURES` above.
 *
 * Everything in that table answers "where may this stand, and who can reach
 * it". Ground answers neither: it is what the cell is *made of*, so it has no
 * anchor, blocks nobody, cannot be lifted, rotated or reached round the back,
 * and is painted over an area rather than placed on a tile. Giving one a row
 * there would mean five fields that are lies and a `canPlace` branch that skips
 * every rule in the function.
 *
 * They are still build KINDS, because they are still things content designs:
 * "Oak Boards" and "Chequer Tile" are rows in the same catalog a planter is a
 * row in, and `create_fixture` gates on this list.
 *
 * `floor` was the only one until the yard pads came in here. The delivery bay
 * and the drop-off were generated furniture — two 2x2 patches the generator
 * stamped against the back wall, that you could neither move, resize nor get
 * rid of — and they are ground in exactly the sense floor is: a cell is made of
 * bay, nothing stands on it. So they became two more designs for the same
 * brush rather than a second mechanism, which is the whole reason `tile` is a
 * field here: one painter, and the KIND of what you painted decides what the
 * cell becomes.
 *
 * The difference between them, and the only one: a floor is a *look*, and a pad
 * is a *job*. `verify:floor` pins the first half — two floors of different
 * colours must produce byte-identical `tiles` — and `pad` is how the second
 * half says so out loud, because a cell that says "deliveries land here" is
 * carrying meaning no colour ever could.
 *
 * `does` is that job in one sentence, and it is a field rather than prose in
 * `docs/fixtures.md` because the generated doc used to branch on the kind id to
 * describe it — two pads, one ternary, and a third would have read as the
 * second. Whatever a pad is for, the row that defines it is where it says so.
 */
export const GROUND = {
  floor: { label: 'Floor', tile: T.FLOOR },
  bay: {
    label: 'Delivery Bay',
    tile: T.BAY,
    pad: true,
    does: 'wholesale orders land here, and how big you paint it is how many crates it holds',
    lastGone: 'that is your last delivery bay — an order would have nowhere to land',
  },
  drop: {
    label: 'Storage',
    tile: T.DROP,
    pad: true,
    does: 'hands are cleared here and stock waits, and how big you paint it is how much waits at once',
    lastGone: 'that is your last storage tile — there would be nowhere to put goods down',
  },
  /**
   * The break area — the first pad that holds people rather than goods.
   *
   * A break has always happened *somewhere*: `PASTIME_SPOTS` names the back of
   * the yard, the front step or the till, which is a pastime saying where it
   * looks right rather than the shop saying where its staff go. This is the
   * shop's answer, and it outranks all of them (`spotFor`, server/sim/staff.js).
   *
   * It is ground rather than a bench on two counts. A bench is one worker and a
   * facing, so a second hire needs a second bench and the shop needs to know
   * which is free; an area is however big you painted it, and one cell seats one
   * person with no fixture, no anchor and no rotation. And it is what makes the
   * size mean something in the same breath the yard does: paint one cell and one
   * hire rests in it while the rest take theirs where they stand.
   *
   * Losing it is a warning rather than a refusal, because the fallback is
   * genuinely the whole of what the game did before — a shop with no break area
   * plays exactly as it always has.
   */
  break: {
    label: 'Break Area',
    tile: T.BREAK,
    pad: true,
    does: 'staff take their breaks here, and how big you paint it is how many of them it seats at once',
    lastGone: 'that is your last break tile — staff would go back to resting wherever they finished',
  },
  /**
   * The car park — the fourth pad, and the first that is not the shop's own
   * ground at all.
   *
   * The bay and the drop-off hold the shop's goods; the break area holds the
   * shop's people. This one holds the people who came to *buy*, which is the
   * whole reason it is neither Yard nor Staff in the palette — filing it beside
   * the bay would put it behind the one word that says it is about stock, and
   * filing it beside the break area would put it behind the one word that says
   * it is about the payroll.
   *
   * Mechanically it is nothing new, and that is the argument for it being ground
   * rather than a fixture with parking bays drawn on it: it is the same brush,
   * the same "how big you paint it is how many it holds" the yard already
   * teaches, and the same one-cell-one-occupant the break area already teaches.
   * Nothing seeds one either, for the break area's reason — a shop with no car
   * park is every shop that exists today, and it plays exactly as it always has.
   *
   * Everything on this row is true of the ground the day it is painted: it is
   * walkable, it is never buildable (`BUILDABLE_INDOOR` is floor and
   * `BUILDABLE_OUTDOOR` is grass, so a pad is neither without a word being
   * written), and it belongs outdoors — indoors it is the same hole a bay is,
   * with the same warning. Who arrives on it and what having driven is worth is
   * step 4b of docs/deliveries.md. The ground goes first deliberately: a
   * mechanic with nowhere to happen is one nobody can measure.
   */
  park: {
    label: 'Car Park',
    tile: T.PARK,
    pad: true,
    does: 'shoppers who drive here leave the car, and how big you paint it is how many of them can',
    lastGone: 'that is your last parking space — nobody would be able to drive to the shop',
  },
  /**
   * The road — the fifth ground kind and the second that is only a *look*.
   *
   * `floor` is the other one, and the pair is the whole taxonomy: the four pads
   * between them carry a job (`pad: true`, and a `does` sentence saying what),
   * and these two carry nothing but a surface. That is why this row is four
   * fields and a bay is six.
   *
   * **It is a preference, never a requirement**, and everything else about it
   * follows from that. `DRIVABLE` in `server/layout.js` has included `GRASS`
   * since the van first drove — every outdoor cell in the game is already a
   * road — so what a painted one changes is which lane the finder *chooses*,
   * by weighing a road cell cheaper than the grass beside it. Pointed the other
   * way, as ground a vehicle must have, it would be a brush that breaks every
   * shop in the world on the re-flow after it ships: no road, no lane, no van.
   *
   * It is also the reason the ring stopped being a technicality. One lorry for
   * six seconds a run could drive over a lawn and nobody minded — that is the
   * argument step 3 of docs/deliveries.md used to turn this down. A dozen
   * shoppers' cars using the same stretch is the busiest ground on the map, and
   * the thing you notice is that it is grass.
   */
  road: {
    label: 'Road',
    tile: T.ROAD,
  },
  /**
   * The pavement — the road's pedestrian twin, and the one ground kind that was
   * already in the game before it had a row.
   *
   * `T.PATH` is the strip the generator lays from the door out to the fields.
   * It has been a tile since long before ground was paintable, so it was
   * hardcoded scenery in exactly the way the delivery bay and the drop-off were
   * before step 13 of docs/building.md — a thing you could see, could not move,
   * and could not have more of. Giving it a kind is the same promotion, and it
   * costs one row: no new enum, no new colour, no renderer change. The generated
   * strip becomes ground you could have painted, which is the yard's rule the
   * other way round.
   *
   * It does the same job for people that a road does for vehicles — `findPath`
   * charges a step across anything else outdoors slightly more — and the two are
   * deliberately the same shape, down to the preference never being cheaper than
   * an ordinary step. What makes it *not* simply the road is that both are true
   * of it at once: `T.PATH` is in `DRIVABLE` and always has been, so a design of
   * this kind painted across a road is a **crossing** — the place the pavement
   * and the lane are the same cell — and that is content rather than a kind.
   */
  path: {
    label: 'Pavement',
    tile: T.PATH,
  },
  /**
   * The lawn — the seventh ground kind, and the last cell in the game that was
   * still a hardcoded colour.
   *
   * `T.GRASS` is what every outdoor cell is made of before anybody paints
   * anything, so it has been in the game since the first world was generated —
   * and it was ground in exactly the sense `path` was: a thing you could see,
   * could not restyle, and could not have a second design of. Worse than the
   * path, in fact, because the renderer did not draw it at all. A grass cell
   * fell through `buildWorld`'s tile loop and what you saw was the big apron
   * plane underneath, one flat colour, with none of the per-cell jitter or baked
   * lamp light every other kind of ground gets. "Our grass is flat" was
   * literally true: there was no grass, there was a box.
   *
   * Giving it a row is the same promotion `path` got and costs the same nothing:
   * no new tile value, no new enum, no migration. Every existing shop is already
   * covered in unpainted `T.GRASS` and stays that way — an unpainted cell has no
   * entry in `layout.ground`, so `surfaceOf` falls back to the tile's own palette
   * colour and a save that has never heard of a lawn design renders as it always
   * did, only jittered.
   *
   * It is a *look* and never a permission, which is the same claim `floor` and
   * `road` make and matters more here than for either: `BUILDABLE_OUTDOOR` is
   * `T.GRASS`, so a bed is dug into whatever lawn you painted and a meadow is
   * still farmland. A design that changed that would not be a design, it would
   * be a kind.
   */
  lawn: {
    // The id is `lawn` and the word is Land, which is the split CLAUDE.md draws
    // about the robots: an id is load-bearing on rows that already exist and a
    // label is what somebody reads. It was called a lawn for about an hour,
    // until the second batch of designs turned out to be bare earth, burnt
    // stubble and gravel — all of them the same brush laying the same tile, and
    // none of them a lawn. Do not "fix" the mismatch later.
    label: 'Land',
    tile: T.GRASS,
  },
};

export const FLOOR_KIND = 'floor';

/**
 * PAINT — what a wall's FACE is finished in.
 *
 * The third partition, and it is neither of the other two on the same grounds
 * they are not each other. A fixture answers "where may this stand and who can
 * reach it"; ground answers "what is this cell made of". Paint answers neither:
 * it has no cell at all. It goes on one *side* of a line between two cells, and
 * the two sides of one wall are two different answers — which is the whole of
 * why it could not have been a ground kind with a different `tile`, and why it
 * is not a fifth glazing either. `GLAZING` and `WAYS` are looks of the wall
 * ITSELF, one per edge; a face is half an edge.
 *
 * Authored exactly as a floor is — a `surface`, which is a colour and a pattern
 * — because it is the same question seen from the side: a wall at this camera
 * is a strip of flat colour with a repeat on it. So `create_fixture` needs no
 * new shape, `artForGround` already draws the swatch, and a new shade of blue
 * is one MCP call. One kind rather than several, because "matt", "gloss" and
 * "brick" are rows in it, not vocabularies of their own — the thing that would
 * earn a second kind here is a finish that DOES something, and a look that does
 * something has stopped being a look.
 *
 * It changes no tile, blocks nobody, encloses nothing and is read by nothing
 * but the renderer. `verify:paint` pins that, the way `verify:floor` pins the
 * same claim about the ground.
 */
export const PAINT = {
  paint: { label: 'Paint' },
};

/** Every kind a piece may name. The closed vocabulary, in one place. */
export const GROUND_KINDS = Object.keys(GROUND);
export const PAINT_KINDS = Object.keys(PAINT);
export const BUILD_KINDS = [...Object.keys(FIXTURES), ...GROUND_KINDS, ...PAINT_KINDS];

/** The ground kinds that carry a job rather than only a look. */
export const PAD_KINDS = GROUND_KINDS.filter((k) => GROUND[k].pad);

/**
 * The kinds that hold GOODS — the three things a unit of shelving can be.
 *
 * They all live in `layout.shelves`, and every one of them is browsed, stocked,
 * reserved, spoiled and re-flowed by the same code. What separates them is only
 * which items may sit on them, which is `requiredFixture` in `shared/tags.js`
 * answering with a kind from this list.
 *
 * It exists because there were two of them and the test was therefore a
 * BOOLEAN. `s.kind === 'freezer' ? 'freezer' : 'shelf'` was written in six
 * files, and every stocking rule in the game was some spelling of
 * `(itemIsFrozen) === (shelfIsFreezer)` — correct, and true only while there is
 * nothing else a shelf can be. A third kind turns every one of those into a
 * silent bug rather than a compile error: a hot counter reads as `'shelf'`,
 * accepts bread, and refuses the roast chicken it was bought for. So the
 * normalisation is here, once, and it is a lookup rather than a ternary.
 */
export const STOCK_KINDS = ['shelf', 'freezer', 'warmer'];

/**
 * Which of `STOCK_KINDS` a stored shelf is, defaulting to plain shelving.
 *
 * The default is load-bearing rather than defensive: `layout.shelves` is
 * persisted, and a save written before this existed holds units with no kind at
 * all beside ones that say `'freezer'`. Both have to come out right with nobody
 * running a migration — the same read-time default `kindOf` gives a piece.
 */
export const shelfKind = (kind) => (STOCK_KINDS.includes(kind) ? kind : 'shelf');

/** Does this kind hold goods? True of a shelf, a freezer and a hot counter. */
export const holdsGoods = (kind) => STOCK_KINDS.includes(kind);

/**
 * The kinds the generator has a budget for, and the kinds it doesn't.
 *
 * Read off `at` rather than off `blocks`, which they used to share: a plot
 * blocks nobody and is still very much a fixture you buy, own and count. A prop
 * is the thing with no budget, because nothing procedural ever places one.
 *
 * Both derive from `FIXTURES` rather than from `BUILD_KINDS`, so a floor is in
 * neither. It has no budget for the same reason a prop hasn't, and it is not a
 * fixture for a stronger one: nothing in the world is ever a floor, the ground
 * simply *is* one.
 */
export const PROP_KINDS = Object.keys(FIXTURES).filter((k) => FIXTURES[k].at != null);
export const FIXTURE_KINDS = Object.keys(FIXTURES).filter((k) => FIXTURES[k].at == null);

export const isProp = (kind) => FIXTURES[kind]?.at != null;

export const isGround = (kind) => GROUND[kind] != null;

export const isPaint = (kind) => PAINT[kind] != null;

/**
 * The two kinds that are authored as a `surface` rather than as a model.
 *
 * Asked by the schema, by the palette and by the thumbnail drawer, and derived
 * rather than written out three times — a kind added to one list and not the
 * others is a row the database accepts and nothing can draw.
 */
export const isSurface = (kind) => isGround(kind) || isPaint(kind);

export const isFloor = (kind) => kind === FLOOR_KIND;

/** Does this ground kind carry a job — a place deliveries land, or stock waits? */
export const isPad = (kind) => GROUND[kind]?.pad === true;

/** What a cell painted with this kind is made of. */
export const groundTile = (kind) => GROUND[kind]?.tile ?? null;

/**
 * Which ground kind a tile value IS, or null for ground nobody painted.
 *
 * The inverse of `groundTile`, and the reason the pads never needed a second
 * array: `tiles` already says which cells are bay, so "where is the bay" is a
 * read rather than a record that can drift out of step with the ground.
 */
export const groundKindOfTile = (tile) => GROUND_KINDS.find((k) => GROUND[k].tile === tile) ?? null;

/** Does one of these own the cell it stands in? */
export const blocksCell = (kind) => FIXTURES[kind]?.blocks === true;


/**
 * Fraction of what a fixture cost that you get back for tearing it out.
 *
 * Shared for the same reason `canPlace` is: the fixture menu prints the refund
 * on the button *before* you press it, and the server is what actually pays it.
 * Two copies of that number is two different amounts of money.
 *
 * It is the shop's one sell-back rate rather than the fixture's, which is why a
 * name with `FIXTURE` in it now reaches the worker menu: stepping back down a
 * ladder — a shelf's tier, a hire's grade — hands back half of the rung you are
 * standing on, and half is half. What that guarantees is the thing a rate per
 * ladder could not: every climb costs money whichever way it is walked, so no
 * amount of up-and-down cycling can print any.
 */
export const FIXTURE_REFUND = 0.5;

/** Quarter turns, clockwise from "anchor to the east" — which is how the
 *  procedural generator has always laid shelves out. */
const FACING = [
  { dx: 1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: -1 },
];

export const rot4 = (rot) => ((Math.round(rot) % 4) + 4) % 4;

/** The tile a worker or shopper stands on to use a fixture placed like this. */
export function anchorTile(x, z, rot) {
  const f = FACING[rot4(rot)];
  return { x: x + f.dx, z: z + f.dz };
}

/**
 * The tile on the far side — where whoever WORKS a fixture stands, as opposed
 * to whoever uses it.
 *
 * Two quarter turns, which is the whole implementation, and that is the reason
 * this is a function rather than a stored offset: a counter's two sides are
 * always opposite, so there is nothing to author and nothing that can drift out
 * of step with the facing.
 */
export function behindTile(x, z, rot) {
  return anchorTile(x, z, rot + 2);
}

/**
 * Every tile a person has to be able to stand on to use this, placed like this.
 *
 * One function, so the ghost, the validator, the generator and the staff all
 * agree about how many spots a thing has and where they are. The `role` is what
 * the preview draws differently: the two sides of a till are not
 * interchangeable, and a player who cannot tell which is which will stand their
 * counter with the queue forming in the stockroom.
 *
 * Ordered use-side first, because that is the side rotation is *about* — a till
 * faces its customers the way a shelf faces its browsers.
 *
 * @returns {Array<{x: number, z: number, role: 'use'|'tend', field: string}>}
 */
export function workSpots(kind, x, z, rot = 0) {
  const def = FIXTURES[kind];
  if (!def) return [];
  const out = [];
  if (def.anchor) out.push({ ...anchorTile(x, z, rot), role: 'use', field: def.anchor });
  if (def.behind) out.push({ ...behindTile(x, z, rot), role: 'tend', field: def.behind });
  return out;
}

/**
 * Where you stand to work a fixture that has already been placed.
 *
 * `workSpots` above answers it from a *spec* — kind, tile, rotation — which is
 * what the ghost and the generator have. This answers it from the placed record,
 * which is what everything downstream has: the spot the layout actually stamped,
 * read back rather than re-derived, so a facing the generator refused is not
 * quietly drawn as though it had been honoured.
 *
 * In `shared/` because the client has to ask it too. A press names the unit you
 * are pointing at (`Game.aimAt`) and is refused out of reach, so the client has
 * to decide whether to send — and reach measured to the fixture on one side and
 * to its working spot on the other is the green-ghost bug: a press that looks
 * legal and comes back as a red toast. One spelling, two callers.
 *
 * Falls back to the fixture itself, which is right for everything that has no
 * side — a decoration, a pad, anything a person stands *on* rather than beside.
 */
export function workSpotOf(f) {
  return f.browseAt ?? f.serveAt ?? f.useAt ?? f;
}

/**
 * How close is close enough to work something without walking.
 *
 * The sim's own number, spelled here for the same reason `workSpotOf` is: the
 * client decides whether a press is worth sending and the server decides whether
 * it lands, and two constants would disagree exactly at the edge — where every
 * complaint about reach comes from.
 */
export const REACH = 1.6;

/**
 * Which way a thing put down HERE should face, given how it is facing now.
 *
 * Aim assist, not a rule. It answers the thing anybody building a row of
 * shelving does by hand and resents doing: standing something against a wall
 * means turning its back to the wall, every time, and there is exactly one
 * right answer per tile, so asking the player for it is asking them to type
 * out a fact the shop already knows.
 *
 * Two tests, and the second is the whole trick. **Usable** is the same
 * condition `whatThisCosts` warns about — somebody can stand where you browse
 * it from, and that spot is indoors. **Backed** is the one that reads a wall:
 * whatever is on the *opposite* side is NOT somewhere a person can be. Usable
 * alone is not enough, and the difference only shows up against a wall running
 * the other way — a shelf on the east wall facing south has a perfectly good
 * browsing spot and is standing side-on to the wall, which is what "it doesn't
 * rotate properly" would have meant.
 *
 * Ties go to the facing it already has, because the search starts there. That
 * is what keeps this from fighting you: out in the middle of the floor nothing
 * is backed, so it returns what you gave it and slides along the wall without
 * spinning. It is also why the caller has to stop asking once the player has
 * turned it by hand — see `rotPinned`.
 *
 * A till is the exception it looks like: it is worked from behind, so its back
 * is a *place* rather than a wall, and the best facing is the one with room on
 * both sides. Same search, opposite test.
 *
 * `keep` is what a fixture you are CARRYING asks for, and it is the difference
 * between assisting and overruling. A new unit off the palette has no facing
 * anybody chose — rot 0 is where the model happens to have been drawn — so the
 * best answer for the tile is the right answer. One you picked up already has
 * one, and it is the one you set the last time it was standing somewhere; a
 * search that improves on it is taking away a decision rather than saving you
 * one. So `keep` settles for a facing that WORKS rather than holding out for
 * the best available: the unit only turns when its own angle would leave it
 * with nowhere to browse it from, which is the case where keeping it would
 * silently cost you the shelf. Everything else — sliding it down a wall, past a
 * corner, along a row — leaves it exactly as you had it.
 */
export function faceAlong(L, spec, { ignoreId = null, keep = false } = {}) {
  const def = FIXTURES[spec.kind];
  const from = rot4(spec.rot ?? 0);
  if (!L || !def?.rotates || !def.anchor) return from;
  const { x, z } = spec;
  /**
   * Can somebody use this unit from that side?
   *
   * One predicate, asked of both sides, and every kind of "no" it has to
   * recognise is in it. The edge test is the one that is easy to leave out and
   * impossible to notice missing: **a wall is not a tile**, it is drawn on the
   * line between two of them, so the far side of your own shop wall is ordinary
   * walkable grass and the far side of an annex divider is ordinary shop floor.
   * Read tiles alone and a shelf against a wall you *drew* stands side-on to
   * it, which is exactly the case somebody building a back room hits first.
   *
   * The indoor test is `whatThisCosts`'s and is asked the same way, or the
   * assist and the warning are two opinions about one question — which is the
   * green-ghost bug with the arrow pointed the other way: a facing the assist
   * refuses to pick and the shop would have accepted. For a `where: 'any'` kind
   * — the skip, which belongs out the back — every side of an outdoor tile
   * failed this, so all four rotations tied at "unusable" and the search fell
   * through to whatever angle you happened to be holding. Assist that answers
   * `from` for all four inputs is assist that is switched off, and it looks
   * exactly like a fixture that simply does not back onto walls.
   */
  const open = (t) => WALKABLE.has(tileAt(L, t.x, t.z))
    && !blockedAt(L, t.x, t.z, ignoreId)
    && (def.where !== 'indoor' || insideStore(L, t.x, t.z))
    && !SOLID.has(edgeBetween(L, x, z, t.x, t.z));
  const usable = (rot) => open(anchorTile(x, z, rot));
  const backed = (rot) => !open(behindTile(x, z, rot));
  const tries = [0, 1, 2, 3].map((i) => rot4(from + i));
  // The bar a facing has to clear to be worth having at all, as opposed to the
  // best one going. It is the same test each search below settles for when it
  // cannot do better — written once so `keep` cannot quietly hold a facing to a
  // different standard than the search that would replace it.
  const workable = def.behind ? (r) => usable(r) && !backed(r) : usable;
  if (keep && workable(from)) return from;
  if (def.behind) return tries.find(workable) ?? from;
  return tries.find((r) => usable(r) && backed(r)) ?? tries.find(usable) ?? from;
}

/**
 * The working spots a fixture ALREADY STANDING has, read off the record rather
 * than recomputed.
 *
 * Not the same question as `workSpots` above, and the difference has bitten
 * this codebase before (`canPlace` vs `canKeep`): that one asks where the spots
 * WOULD be for a placement being judged, this one asks where they ARE for
 * something the generator has already laid down. A record is the authority on
 * its own spots — `serveAt` is stored, not derived, because a till that was
 * turned mid-compose would otherwise report the facing it used to have.
 */
export function spotsOf(f, { layout = null, open = false } = {}) {
  const def = FIXTURES[f?.kind];
  if (!def) return [];
  const out = [];
  const use = f.browseAt ?? f.serveAt ?? f.useAt;
  if (use) out.push({ ...use, role: 'use' });
  if (def.behind && f[def.behind]) out.push({ ...f[def.behind], role: 'tend' });
  if (!def.ends || !use) return out;

  // The ends, and — if the piece or its rung says it is open all round — the
  // back, which is `openOf`'s answer and never a field on the placement. Derived
  // rather than stored, which is the opposite call to `browseAt` and the right
  // one for the same reason: the anchor is a DECISION made when the thing was
  // laid and has to survive being read back, while these are a fact about a box
  // standing on a tile and are true again every time you ask.
  //
  // Filtered against the shop, or the picture lies: an end that is inside a
  // wall, under another shelf or across a wall line is not a place anybody can
  // stand, and marking it would be advertising a spot the game will not accept
  // you at. Without a layout there is nothing to filter against, which is what
  // an unplaced ghost is — see `workSpots`, which answers the same question for
  // a placement being judged.
  const rot = rot4(f.rot ?? 0);
  const more = open ? [rot + 1, rot + 3, rot + 2] : [rot + 1, rot + 3];
  const seen = new Set(out.map((s) => `${s.x},${s.z}`));
  for (const r of more) {
    const t = anchorTile(f.x, f.z, r);
    if (seen.has(`${t.x},${t.z}`)) continue;
    if (!standableSide(layout, f, t)) continue;
    seen.add(`${t.x},${t.z}`);
    out.push({ ...t, role: 'side' });
  }
  return out;
}

/**
 * Can somebody actually stand HERE and work the thing next to them?
 *
 * Two tests, and the second is the one a tile lookup cannot make: the ground
 * has to take a person and hold nothing (`isWalkableTile`, which is what the
 * walk grid itself is built from), and the line between that tile and the unit
 * has to not be a wall. Leaving the edge test out works perfectly against every
 * generated shop and fails the day somebody draws a divider — the same trap
 * `faceAlong` documents, where the far side of your own shop wall is ordinary
 * walkable grass.
 */
function standableSide(L, f, t) {
  if (!L) return true;
  if (!isWalkableTile(L, t.x, t.z)) return false;
  return !SOLID.has(edgeBetween(L, t.x, t.z, f.x, f.z));
}

/**
 * A step in model space, turned to face the way a fixture was actually stood.
 *
 * Models are authored facing east — rot 0 — so "the +z end of this unit" is
 * only a direction in the world once you know which way round it is. One
 * quarter turn takes +x to +z, which is the order `FACING` is indexed in.
 */
export function turn({ dx, dz }, rot) {
  let s = { dx, dz };
  for (let i = rot4(rot); i > 0; i--) s = { dx: -s.dz, dz: s.dx };
  return s;
}

/** For a till, the direction the queue trails off in: along the wall it faces. */
export function queueAxis(rot) {
  // Perpendicular to the serving direction, so the line forms beside the till
  // rather than stacking on top of the person being served.
  return rot4(rot) % 2 === 0
    ? [{ x: 0, z: 1 }, { x: 0, z: -1 }]
    : [{ x: 1, z: 0 }, { x: -1, z: 0 }];
}

// ---------------------------------------------------------------------------
// Reading a layout
// ---------------------------------------------------------------------------

export const tileAt = (L, x, z) =>
  (x < 0 || z < 0 || x >= L.w || z >= L.h ? -1 : L.tiles[z * L.w + x]);

/**
 * Is something standing in this cell?
 *
 * A mask, derived once by the generator from the fixture lists, rather than a
 * scan of those lists — because this is asked for every cell of a flood fill,
 * for every step of every path, sixty times a second while a ghost is up.
 *
 * `ignoreId` is the one thing that can un-block a cell: the fixture you are
 * currently moving has already left, as far as the question "may it go here"
 * is concerned, or a shelf could never be shuffled one square along. That costs
 * a list scan, which is why it is only paid when something is actually in the
 * air rather than folded into the mask.
 */
export function blockedAt(L, x, z, ignoreId = null) {
  if (x < 0 || z < 0 || x >= L.w || z >= L.h) return false;
  if (!L.blocked?.[z * L.w + x]) return false;
  if (!ignoreId) return true;
  const moving = fixturesOf(L).find((f) => f.id === ignoreId);
  return !(moving && Math.round(moving.x) === x && Math.round(moving.z) === z);
}

/**
 * Can a person be in this cell?
 *
 * Both halves, always: walkable ground *and* nothing standing on it. These were
 * one question while a tile said both at once, and separating them is the whole
 * of step 5 — the floor under a shelf is floor, and it goes back to being floor
 * the moment the shelf is sold.
 */
export const isWalkableTile = (L, x, z) =>
  WALKABLE.has(tileAt(L, x, z)) && !blockedAt(L, x, z);

/**
 * Is this cell indoors?
 *
 * Not "within the store rectangle" any more — within *anything the walls close
 * in*. The layout carries an `indoor` mask flooded from the map border through
 * the edges (`computeIndoor`, shared/edges.js), so an L-shaped shop, a lean-to
 * annex, a barn across the yard and a glasshouse in the middle of the field are
 * all indoors, and none of them is a case anybody had to write.
 *
 * Two consequences worth knowing, because they are rules now rather than
 * accidents. Floor you never enclosed is a patio — outdoors, so no shelf may go
 * on it. And a patch of grass you wall in is indoors, so no plot may be dug
 * there. Both fall out of asking the walls instead of asking the rect.
 *
 * The name is kept deliberately: it has call sites on both sides of the wire
 * and in two verify sweeps, and renaming it buys nothing a comment can't say.
 * The rect fallback is for a layout built before masks existed — the generator
 * has emitted one since edges landed.
 */
export function insideStore(L, x, z) {
  if (x < 0 || z < 0 || x >= L.w || z >= L.h) return false;
  if (L.indoor) return L.indoor[z * L.w + x] === 1;
  const s = L.store;
  return x >= s.x && x < s.x + s.w && z >= s.z && z < s.z + s.h;
}

/**
 * How long a line may get before the shop is the problem rather than the lane.
 *
 * Not a tuning knob for how a queue *looks* — a lane that bends has as many
 * slots as the room has floor, and the reason to stop counting is that a
 * sixteenth shopper at one till means the turn-away rule should have fired
 * long ago. It is a backstop on the walk, not a shape.
 */
export const QUEUE_LANE_MAX = 16;

/** Rotate a step 90°, in a grid where +x is east and +z is south. */
const cwTurn = (d) => ({ x: -d.z, z: d.x });
const ccwTurn = (d) => ({ x: d.z, z: -d.x });

/**
 * Where a till's line actually stands — one tile per place in it.
 *
 * This replaces `openRun`, which measured a *straight* run and stopped at the
 * first thing in the way — the shape the queue used to be. A fixed count of
 * slots, and anybody past the end of it was handed the last one, so a till that
 * was doing well grew a pile of shoppers standing inside one another instead of
 * a line. It got worse exactly as the shop got better, which is why it read as
 * the game breaking under load rather than as a missing turn.
 *
 * A line in a room turns the corner rather than ending. This walks the lane a
 * tile at a time — straight while it can, and round when it can't, preferring
 * to keep bending the way it bent last so the tail curls along the wall instead
 * of jittering side to side. Every rule the straight run enforced still holds
 * at every step, including the one only an edge can answer: a queue may not run
 * through a wall, so the boundary crossed to reach each tile counts as much as
 * the tile does. `used` is what stops the curl eating its own tail.
 *
 * **`lane[0]` is `from`** — the person being served is in the queue. That is
 * what lets every caller say "slot i is `lane[i]`" with no arithmetic, which is
 * where the old off-by-one pile-up lived.
 *
 * `claimed` is passed in by whoever lays every till at once, so two tills side
 * by side grow two lines rather than one line twice. Without it the first lane
 * laid runs through the second till's front, and which till that is comes down
 * to array order.
 *
 * A lane is grown a step at a time rather than in one go because `queueLanes`
 * needs to interleave them — see there.
 */
export function queueLane(L, from, dir, opts = {}) {
  const lane = startLane(L, from, dir, opts);
  while (growLane(lane));
  return lane.tiles;
}

const sameStep = (a, b) => a.x === b.x && a.z === b.z;

function startLane(L, from, dir, opts = {}) {
  const { max = QUEUE_LANE_MAX, claimed = null, blocked = () => false } = opts;
  return {
    L,
    max,
    claimed,
    blocked,
    /**
     * WHETHER THIS LANE IS AN INDOOR ONE, decided by where it starts.
     *
     * "A queue stays indoors" is the right rule for a till in a room, and it is
     * asserted as one in `verify:layout`. It is not a rule a till can *obey*
     * when there is no room: knock the back wall through and enclosure is
     * gone, so `insideStore` is false on every tile in the world — no lane can
     * grow a single step, every lane comes out length 1, and `queueSlot` then
     * clamps every shopper in the shop onto the serving tile. A real shop hit
     * exactly that and it reads as the queue code having broken, because what
     * you see is a heap of people standing inside one another at the counter
     * and nothing anywhere connecting it to a wall you took out last week.
     *
     * So the requirement is the *serving spot's own* answer rather than a
     * constant. A till standing in a room queues in that room, exactly as
     * before, and every generated shop is that case — which is why nothing in
     * the sweeps moves. A till with no room around it queues on whatever floor
     * it can reach, which is a line rather than a pile, and is the same call
     * the rest of this file makes about strange buildings: the sim copes, and
     * you keep what you built.
     */
    indoorOnly: insideStore(L, from.x, from.z),
    tiles: [{ x: from.x, z: from.z }],
    used: new Set([`${from.x},${from.z}`]),
    heading: dir,
    // Which way the line bent last, so the second corner turns the same way as
    // the first. A lane that alternates reads as a crowd; one that keeps
    // curling reads as a line that went round something.
    bend: cwTurn,
  };
}

/**
 * Add one place to the end of a line, or report that there is nowhere to add
 * one. Never writes to `claimed` — the caller sharing that set decides when a
 * tile is spoken for, and `queueLane` calls this twice per till to choose a
 * direction, which would otherwise have the first choice block the second.
 */
function growLane(s) {
  if (s.tiles.length > s.max) return false;
  const at = s.tiles[s.tiles.length - 1];
  // Straight first, then the two corners — never the reverse, which is the one
  // turn that would walk the line back up itself.
  const turn = s.bend(s.heading);
  for (const d of [s.heading, turn, (s.bend === cwTurn ? ccwTurn : cwTurn)(s.heading)]) {
    const x = at.x + d.x;
    const z = at.z + d.z;
    const key = `${x},${z}`;
    if (s.used.has(key) || s.claimed?.has(key)) continue;
    // A line may not run through a wall, and it may not run through a way
    // through that has a rule on it either. `RULED` rather than
    // `shopperCanCross`, because a lane is grown from the till OUTWARD and
    // walked toward the till, so a one-way door would be crossable in whichever
    // direction this loop happened to ask about — and a queue that files in
    // through the entrance and cannot leave is not a queue. Nothing about a
    // staff-only door wants a customer standing in it either way.
    const line = edgeBetween(s.L, at.x, at.z, x, z);
    if (SOLID.has(line) || RULED.has(line)) continue;
    // The wall between two tiles still stops the line either way — a queue may
    // not run through one whether or not the shop has an inside. What relaxes
    // when there is no inside is only which floor counts. See `indoorOnly`.
    if (s.indoorOnly && !insideStore(s.L, x, z)) continue;
    if (!isWalkableTile(s.L, x, z) || s.blocked(x, z)) continue;
    // Bent the other way, so the next corner should follow this one. Compared
    // by value: every turn helper mints a fresh object, so `===` on a step is
    // always false and the line would forget which way it last bent.
    if (!sameStep(d, s.heading) && !sameStep(d, turn)) {
      s.bend = s.bend === cwTurn ? ccwTurn : cwTurn;
    }
    s.heading = d;
    s.tiles.push({ x, z });
    s.used.add(key);
    return true;
  }
  return false;
}

/**
 * Every till's lane, keyed by till id, laid against one shared `claimed` set.
 *
 * The lanes are grown **in step with each other**, a place at a time, and that
 * is the whole of this function. Laying one line to its full length before
 * starting the next hands the first till the entire aisle: with the generator's
 * tills three tiles apart, till #1's line runs the length of the shop, round
 * the corner and back, and till #2 then finds every tile beside it spoken for
 * and gets a line of nobody. It reads as "the second till is broken", and the
 * shop it happens in looks completely ordinary.
 *
 * Interleaving is also just what a queue is. Two lines beside each other grow
 * away from one another because each has already taken the tile the other
 * would have wanted next — nobody has to arbitrate.
 *
 * The sim, the generator's final measure and `verify:layout` all come through
 * here, so there is one answer to where a line stands rather than three that
 * agree right up until one of them is edited.
 */
export function queueLanes(L) {
  const tills = (L.checkouts ?? []).filter((t) => t.serveAt && t.queueDir);
  const claimed = new Set();
  // Every serving spot is spoken for before any line is laid, including the
  // ones whose line has not started yet — otherwise the first lane runs through
  // the second till's front.
  for (const t of tills) claimed.add(`${t.serveAt.x},${t.serveAt.z}`);

  const growing = tills.map((t) => startLane(L, t.serveAt, t.queueDir, { claimed }));
  for (let moved = true; moved;) {
    moved = false;
    for (const s of growing) {
      if (!growLane(s)) continue;
      const end = s.tiles[s.tiles.length - 1];
      claimed.add(`${end.x},${end.z}`);
      moved = true;
    }
  }

  return new Map(tills.map((t, i) => [t.id, growing[i].tiles]));
}

/**
 * A FACE — one side of one edge, which is what paint goes on.
 *
 * An edge is a line between two cells and has two of them, so a face is the
 * edge plus which way it looks. `s` is -1 or 1 along the edge's own normal: a
 * vertical edge at x separates cell x-1 (that is `-1`) from cell x (`1`), and a
 * horizontal one at z separates cell z-1 from cell z the same way.
 *
 * Numbers rather than 'inside'/'outside', and that is the decision this rests
 * on. Which side is indoors is a fact about the *shop*, not about the wall —
 * `computeIndoor` re-answers it every re-flow, and a room you wall off changes
 * it for edges nobody touched. Stored as "the inside face", a paint job would
 * silently swap sides the day you extended the building, which is the bay
 * window trap (`outward` in the renderer) with a colour on it. The geometry
 * never moves, so the geometry is what it is keyed to.
 *
 * One string, because the whole overlay is a map and three readers have to
 * agree about it — the same argument `countKey` makes for a fixture.
 */
export const faceKey = (f) => `${f.o}:${f.x}:${f.z}:${f.s < 0 ? -1 : 1}`;

/** ...and back, for a reader that has the key and wants the geometry. */
export function faceOf(key) {
  const [o, x, z, s] = String(key).split(':');
  return { o, x: Number(x), z: Number(z), s: Number(s) };
}

/**
 * May this face take paint?
 *
 * Almost nothing to say no about, which is the point: paint reads nothing, moves
 * no tile and encloses nothing, so the only genuine refusal is that there is no
 * wall there to paint. Everything `canPlaceEdges` has to worry about — sealing
 * the shop, stranding a fixture, the border ring — is about what a wall DOES,
 * and a face does nothing.
 *
 * Glass is the one exception and it is not a rule about paint, it is a rule
 * about where paint LANDS: a pane takes its colour from the wall it is set in
 * (see `paintedBands`), so a face whose edge is nothing but glass has nowhere
 * to put it. There is no such edge today — every glazing has a sill and a
 * header — which is why this asks about the edge existing and not about that.
 */
export function canPaintFaces(L, faces) {
  const nope = (reason) => ({ ok: false, reason });
  if (!faces?.length) return nope('nothing to paint');
  for (const f of faces) {
    if (f.o !== 'v' && f.o !== 'h') return nope('that is not a wall line');
    if (!edgeAt(L, f)) return nope('there is nothing there to paint');
  }
  return { ok: true };
}

/** What is on this line right now — the read `canPaintFaces` is made of. */
export function edgeAt(L, f) {
  const x = Math.round(f.x);
  const z = Math.round(f.z);
  if (f.o === 'v') {
    if (x < 0 || z < 0 || x > L.w || z >= L.h) return E.NONE;
    return L.edgesV?.[z * (L.w + 1) + x] ?? E.NONE;
  }
  if (x < 0 || z < 0 || x >= L.w || z > L.h) return E.NONE;
  return L.edgesH?.[z * L.w + x] ?? E.NONE;
}

/**
 * The faces a paint drag covers — `edgeRun` with a side carried through.
 *
 * The side is the one the drag STARTED on, for every segment of it, rather than
 * re-read per segment: a drag along the front of the shop crosses the doorway
 * and both bay corners, and a run that re-decided at each step would paint the
 * inside of the two segments your cursor happened to drift across. You said
 * which face when you pressed.
 *
 * Runs of faces that have no wall are dropped rather than refused, which is the
 * opposite of what building a wall does and right for the same reason a floor
 * drag is: you are dragging along a wall that is already there, so a gap in it
 * is a gap, not a mistake.
 */
export function faceRun(L, start, to, max = 40) {
  return edgeRun(start, to, max)
    .map((seg) => ({ ...seg, s: start.s < 0 ? -1 : 1 }))
    .filter((f) => edgeAt(L, f) !== E.NONE);
}

/**
 * May a wall, window or doorway go on this line?
 *
 * Same two answers as `canPlace`, and the same reasoning: off the map is
 * physics, but sealing your own shop is a *move*. You are allowed to wall off
 * the aisle, brick up the front door, or box a till into a cupboard — the game
 * says what it will cost and lets you, because a builder that refuses strange
 * buildings is a level editor with opinions.
 *
 * @param {object} spec { o: 'v'|'h', x, z, kind }
 */
export function canPlaceEdge(L, spec) {
  return canPlaceEdges(L, [spec], spec.kind ?? E.WALL);
}

/** Where a wall run from `start` to the far index `to` lays its segments. */
export function edgeRun(start, to, max = 40) {
  const o = start.o === 'v' ? 'v' : 'h';
  const x = Math.round(start.x);
  const z = Math.round(start.z);
  const end = to == null ? (o === 'v' ? z : x) : Math.round(to);
  const from = o === 'v' ? z : x;
  const lo = Math.min(from, end);
  const hi = Math.min(Math.max(from, end), lo + max - 1);
  const out = [];
  // A run follows the line it started on: a horizontal segment lies along x, a
  // vertical one along z. Turning a corner is a second drag, which is both
  // simpler to reason about and what a drawn wall actually wants.
  for (let i = lo; i <= hi; i++) out.push(o === 'v' ? { o, x, z: i } : { o, x: i, z });
  return out;
}

/**
 * The same question for a whole run at once.
 *
 * Asked once for the run rather than once per segment, because "does this seal
 * the shop" is only true of the run as a whole — no single segment of a wall
 * across the aisle seals anything, and validating them one at a time would
 * report no warning at all right up until the shop was shut.
 */
export function canPlaceEdges(L, segs, kind = E.WALL) {
  if (!segs?.length) return no('nothing to build');

  for (const s of segs) {
    const o = s.o;
    const x = Math.round(s.x);
    const z = Math.round(s.z);
    if (o !== 'v' && o !== 'h') return no('that is not a wall line');
    // A lattice line, not a cell: a vertical run has one more column than the
    // grid has cells, and vice versa. Off-by-one here writes into the next row.
    const maxX = o === 'v' ? L.w : L.w - 1;
    const maxZ = o === 'v' ? L.h - 1 : L.h;
    if (x < 1 || z < 1 || x > maxX - 1 || z > maxZ - 1) return no('off the edge of the world');
  }

  let probe = L;
  for (const s of segs) probe = withEdge(probe, s, kind);
  // `withEdge` carries the OLD `indoor` mask across, and a one-way door reads
  // which way is in off that mask — so the probe has to be told what it would
  // enclose before anything asks it a question about a shopper. Computed once
  // here rather than twice below, which is what it used to cost.
  const after = computeIndoor(probe);
  probe = { ...probe, indoor: after };

  // Taking a wall out can't strand anybody — a hole only ever opens the way —
  // so a demolition skips every reachability question below. What it can still
  // do is un-roof, which is the half neither check used to cover.
  if (kind) {
    const from = L.spawn ?? L.door;
    // Asked as a SHOPPER, which is the whole of the first warning since a way
    // through can be signed: unchanged, you could turn your own front door
    // staff-only or exit-only and the game would say nothing at all while no
    // customer could ever come in again — a shop that looks completely normal
    // and takes no money.
    const seen = reachable(probe, from.x, from.z, undefined, shopperCanCross);
    const at = (p) => seen.has(`${Math.round(p.x)},${Math.round(p.z)}`);

    if (!at(L.door)) return { ok: true, warn: 'that seals the shop — nobody can get in' };

    // A fixture asks a narrower question than "can anybody walk here", and it
    // has to since the yard behind the shop got its own door: the outside now
    // joins the two ends of any interior wall you can draw, so by the flood
    // above a partition straight across the aisles strands nothing at all. It
    // would go quiet on precisely the wall most worth warning about.
    //
    // What a shelf actually needs is to be reachable *on the shop floor* from
    // the front door — the trip a shopper makes. Out of the door, round the
    // building and in the back is a route, not a shop.
    //
    // Judged only on what is indoors after the change, so a shelf already out
    // on the patio isn't re-reported on every wall you ever draw; and skipped
    // entirely if the doorway itself ends up outdoors, which means the shell is
    // open rather than partitioned and is `whatThisUnroofs`'s story to tell.
    const indoors = (x, z) => (x < 0 || z < 0 || x >= L.w || z >= L.h
      ? false
      : after[z * L.w + x] === 1);

    if (indoors(Math.round(L.door.x), Math.round(L.door.z))) {
      // Deliberately NOT a shopper's flood, unlike the one above. If this went
      // shopper-solid too, every shelf you ever stand in a stockroom would warn
      // "that cuts a shelf off from the door" on every wall you drew afterwards,
      // for ever, about something you did on purpose. Same argument
      // `whatThisUnroofs` already makes: report what the action *changes*.
      const onFloor = reachable(probe, L.door.x, L.door.z,
        (P, x, z) => indoors(x, z) && isWalkableTile(P, x, z));
      const joined = (p) => onFloor.has(`${Math.round(p.x)},${Math.round(p.z)}`);

      // ANY of a fixture's working spots being cut off strands it, which for a
      // till means the clerk's side counts: a wall drawn between the counter
      // and the back of the shop leaves a till the queue can still reach and
      // nobody can ever staff, and that is exactly the wall worth warning about.
      // `layout` matters, and it is the difference between this warning firing
      // for a reason and firing always. A unit's ENDS are derived rather than
      // stored, so unfiltered they include tiles nobody could ever stand on —
      // and a run of shelving is solid down the column now (`SHELF_ROW_PITCH`),
      // which means every unit in it has another unit for an end. `every` then
      // reads that as stranded whatever wall you drew, so a shop with an aisle
      // in it warned "that cuts 11 fixtures off from the door" about a single
      // segment in a corner. Filtered against the shop as it stands *before*
      // the change, which is what makes this a delta.
      const stranded = fixturesOf(L)
        .map((f) => ({ f, spots: spotsOf(f, { layout: L }) }))
        .filter(({ f, spots }) => spots.length
          && indoors(Math.round(f.x), Math.round(f.z))
          && !spots.every(joined));
      if (stranded.length) {
        const what = FIXTURES[stranded[0].f.kind]?.label.toLowerCase() ?? 'fixture';
        return {
          ok: true,
          warn: stranded.length === 1
            ? `that cuts a ${what} off from the door`
            : `that cuts ${stranded.length} fixtures off from the door`,
        };
      }
    }
  }

  const roof = whatThisUnroofs(L, after);
  return roof ? { ok: true, warn: roof } : { ok: true };
}

/**
 * What changing these edges would do to what counts as indoors.
 *
 * The half of "what will this cost me" that reachability cannot see. A shelf
 * has to be indoors and a plot has to be outdoors, and neither of those is about
 * being able to *walk* anywhere: knock the back wall through and a shelf nobody
 * touched is standing in a yard, wall the farm in and a bed nobody touched is in
 * a room. Both follow from `insideStore` meaning "whatever the walls close in",
 * so both arrived the day enclosure did and neither had anything watching for
 * it.
 *
 * This is also the answer to the demolition question docs/building.md left open.
 * Removal genuinely cannot strand a fixture the way placement can — that is why
 * it warned about nothing at all — but it can un-roof half the shop, and that is
 * worth being told before you swing rather than after.
 *
 * A consequence, not a refusal, exactly as everything else here is: putting your
 * shelving out in the weather is allowed, and the sim copes with it (a shelf
 * outdoors keeps its stock and keeps selling; what you lose is the right to
 * build another one beside it).
 */
function whatThisUnroofs(L, after) {
  const inside = (x, z) => (x < 0 || z < 0 || x >= L.w || z >= L.h
    ? false
    : after[z * L.w + x] === 1);

  const evicted = [];
  const roofed = [];
  for (const f of fixturesOf(L)) {
    const def = FIXTURES[f.kind];
    // `any` is a decoration, which is at home either way and has no opinion.
    if (!def || def.where === 'any') continue;
    const x = Math.round(f.x);
    const z = Math.round(f.z);
    // Only what this *changes*. Reported absolutely, a shop that already has a
    // shelf out on the patio would warn about it on every wall you ever drew,
    // and a warning that fires whatever you do is one nobody reads.
    const was = insideStore(L, x, z);
    const isIn = inside(x, z);
    if (was === isIn) continue;
    if (def.where === 'indoor' && !isIn) evicted.push(f);
    else if (def.where === 'outdoor' && isIn) roofed.push(f);
  }

  const label = (list) => FIXTURES[list[0].kind]?.label.toLowerCase() ?? 'fixture';
  if (evicted.length === 1) return `that leaves a ${label(evicted)} standing outside`;
  if (evicted.length) return `that leaves ${evicted.length} fixtures standing outside`;
  if (roofed.length === 1) return `that roofs over a ${label(roofed)} — nothing grows indoors`;
  if (roofed.length) return `that roofs over ${roofed.length} plots — nothing grows indoors`;
  return null;
}

// ---------------------------------------------------------------------------
// Laying a floor
//
// The third gesture, and the one that had been missing. A fixture is placed on
// a tile and a wall is drawn along a line; a floor is painted over an AREA,
// because "make this corner of the yard into shop" is a region and clicking it
// out one square at a time is not something anybody does twice.
//
// What it changes is `tiles` and only `tiles` — GRASS becomes FLOOR, FLOOR
// becomes GRASS — which is the whole reason it needed no new tile kinds. Every
// rule that already reads the ground reads the new ground for free: a shelf
// still needs `BUILDABLE_INDOOR`, a plot still needs bare grass, and both stay
// exactly as strict as they were. Which design of floor it is rides in a
// separate layer entirely (`layout.floors`), because a look must never be able
// to change what may stand somewhere.
//
// The pairing with walls is the point. Since enclosure replaced the store rect
// you could already wall off an annex, and it counted as indoors — and then
// refused every shelf you tried to put in it, because the ground under it was
// still grass. Walls said "this is a room" and nothing could say "this is a
// floor". That is the missing half, and it is why a floor tool is also the
// answer to "how do I make my shop bigger".
// ---------------------------------------------------------------------------

/**
 * Longest side of one paint stroke.
 *
 * A cap on the gesture, not on how much ground you may own — drag again. It is
 * here because a stroke is charged and re-flowed as one action: the drag has to
 * arrive as two corners (the 4KB inbound cap), it is priced per cell, and every
 * cell of it is validated before any of it is paid for.
 */
export const GROUND_STROKE_MAX = 16;

/**
 * How thick a lane the road brush lays, whatever you dragged.
 *
 * A car is 1.21 tiles wide — see the `vehicles` rows — so a one-cell lane is
 * one a car hangs off both edges of. That is a scale fact rather than a taste,
 * and the brush is where it belongs: a road you can draw too narrow for the
 * things that drive on it is a brush that lets you make a mistake with no way
 * to see you have made it, because the lane finder is perfectly happy with one
 * cell and the ghost is green either way.
 *
 * It is a FLOOR on the thickness rather than a fixed size — drag a wide
 * rectangle and you get what you dragged. One drag is one road; four drags is
 * a car park you should have painted with the car park brush.
 */
export const ROAD_THICK = 2;

/**
 * The cells a drag from `start` to `to` would paint.
 *
 * Clamped around `start` rather than around the lower corner, which is the one
 * place this differs from `edgeRun` and is a deliberate fix rather than a
 * divergence: clamping a rect by its minimum trims the corner you began the
 * drag on, so an oversized stroke up and to the left walks away from your
 * finger instead of stopping under it.
 *
 * `thick` widens a stroke that came out thinner than that, which is the road
 * brush and nothing else. **Which way it widens has to be decided here**, in
 * the one function both the ghost and the server run: the client sends the two
 * ends of the drag and never the cells (the 4KB inbound cap), so a rule the
 * preview applied and the server did not would be a green ghost promising a
 * road the shop then refuses. It grows towards the higher coordinate, and away
 * from it when that would run off the map — which is not a nicety, it is the
 * seeded street: that sits in the bottom paintable row, so a road brush that
 * only ever grew downward could never redraw the one the world starts with.
 */
export function groundStroke(start, to, max = GROUND_STROKE_MAX, thick = 1, L = null) {
  const x0 = Math.round(start.x);
  const z0 = Math.round(start.z);
  const near = (from, end) => (end > from
    ? Math.min(end, from + max - 1)
    : Math.max(end, from - max + 1));
  const x1 = to == null ? x0 : near(x0, Math.round(to.x));
  const z1 = to == null ? z0 : near(z0, Math.round(to.z));

  let ax = Math.min(x0, x1);
  let bx = Math.max(x0, x1);
  let az = Math.min(z0, z1);
  let bz = Math.max(z0, z1);

  if (thick > 1) {
    // The thin axis is the one that gets widened, and a stroke thin both ways —
    // a single tap — is widened across rather than along, so a tap lays a stub
    // of road pointing the way a road points.
    const wide = bx - ax + 1;
    const deep = bz - az + 1;
    const grow = (a, b, limit) => {
      const room = Math.min(thick - (b - a + 1), max - (b - a + 1));
      if (room <= 0) return [a, b];
      // Down/right unless that leaves the world, in which case up/left.
      if (limit == null || b + room <= limit) return [a, b + room];
      return [Math.max(1, a - room), b];
    };
    if (deep <= wide && deep < thick) [az, bz] = grow(az, bz, L ? L.h - 2 : null);
    else if (wide < thick) [ax, bx] = grow(ax, bx, L ? L.w - 2 : null);
  }

  const out = [];
  for (let z = az; z <= bz; z++) {
    for (let x = ax; x <= bx; x++) out.push({ x, z });
  }
  return out;
}

/** How thick a stroke of this kind comes out, whatever was dragged. */
export const strokeThick = (kind) => (kind === 'road' ? ROAD_THICK : 1);

/**
 * Which design of ground is painted on each cell, as a lookup.
 *
 * The layer that carries the *design*, kept clear of `tiles`, which carries
 * what may stand there. Sparse and rebuilt per call rather than emitted as a
 * full-grid array: an unpainted shop sends nothing at all, and the alternative
 * is a second w×h array on the wire on every re-flow to say "plain" 500 times.
 *
 * Reads `ground`, falling back to `floors` — the name this carried while floor
 * was the only thing you could paint. A read-time default rather than a
 * migration, the same bargain `kindOf` strikes for a row with no `kind`, so an
 * old save, an old export and a fresh seed all agree with no ceremony.
 */
export function groundIndex(L) {
  const m = new Map();
  for (const f of L?.ground ?? L?.floors ?? []) m.set(`${f.x},${f.z}`, f.p);
  return m;
}

export const groundPieceAt = (L, x, z) => groundIndex(L).get(`${x},${z}`) ?? null;

/**
 * Every cell of one pad, read off `tiles`.
 *
 * A read, deliberately, rather than a list kept beside the ground — the same
 * argument `Game.fixtureCounts` makes against the fixture ledger it replaced. A
 * stored region can disagree with what the cells actually are; a scan cannot.
 * It also means a pad is however many cells you painted, in whatever shape, and
 * nothing has to be taught what an L looks like.
 */
export function padCells(L, kind) {
  const want = groundTile(kind);
  const out = [];
  if (want == null || !L?.tiles) return out;
  for (let z = 0; z < L.h; z++) {
    for (let x = 0; x < L.w; x++) if (L.tiles[z * L.w + x] === want) out.push({ x, z });
  }
  return out;
}

/** Is this cell part of that pad? */
export const isPadAt = (L, kind, x, z) => tileAt(L, x, z) === groundTile(kind);

/**
 * The pads that hold GOODS, as opposed to the ones that hold people.
 *
 * `PAD_KINDS` is all four — the bay, the drop-off, the break area and the car
 * park — and it is the right list for anything asking "is this painted ground
 * doing a job". It is exactly the wrong list for anything moving stock, and
 * that is the boolean-over-two-kinds trap wearing painted ground: for as long
 * as every pad held goods, `PAD_KINDS` and "somewhere a crate may go" were the
 * same set by coincidence rather than by rule, and the break area is what
 * retired that. A crate of frozen chicken set down where your crew take their
 * charge is not wrong in any way the code can see — it is a box on a pad — and
 * nothing anywhere would say a word.
 *
 * `Game.onAPad` has spelled this inline as `bay || drop` since crates could be
 * packed. This is that spelling, named, so the sim and anything drawing a
 * picture of the sim cannot drift apart about it.
 */
export const GOODS_PADS = ['bay', 'drop'];

/**
 * May this stroke be painted?
 *
 * Same two answers as everything else here, and the split falls in a slightly
 * different place because this is ground: almost all of it is physics. There is
 * no "you could seal yourself in" to warn about, since every ground kind is
 * walkable and swapping one for another cuts nothing off from anything.
 *
 * The one refusal worth spelling out is taking ground out from under something
 * standing on it. That reads like the kind of consequence this codebase usually
 * allows you to cause — and it isn't, because the generator would not leave the
 * shelf standing on grass, it would DROP the placement on the next re-flow and
 * refund it. A tool that quietly sells your shelving and its stock back is not a
 * choice anybody made; it is a bulldozer wearing a paintbrush. So it is a no,
 * and the bulldozer is right there.
 *
 * One kind of ground may be painted straight over another, and that is what
 * makes the pads editable at all: moving your delivery bay is painting a new
 * one and then flooring over the old, with no separate verb for erasing.
 *
 * @param {object} L        the layout
 * @param {object[]} cells  [{x, z}], from `groundStroke`
 * @param {?string} kind    which ground kind to lay, or null to take it up
 * @param {?string} piece   which design of that kind
 */
export function canPaintGround(L, cells, kind = null, piece = null) {
  if (!cells?.length) return no('nothing to lay');
  const laying = kind != null;
  if (laying && groundTile(kind) == null) return no('that is not a kind of ground');
  const lay = laying ? groundTile(kind) : null;
  /**
   * What this stroke LEAVES on a cell — and taking ground up has two answers.
   *
   * Outdoors it is grass, which is what the world is made of before anybody
   * does anything. Indoors it is FLOOR, because grass is not what is under a
   * shop: a building whose ground you scraped is not a lawn with walls round
   * it, it is a shop with a hole in it — a cell that refuses every shelf and
   * every bed, which is the one thing `bared` exists to warn about. The eraser
   * was the only tool in the game that could make one without asking, and it
   * did it on the most ordinary press there is: undoing a floor design you had
   * just laid.
   *
   * Per cell rather than per stroke, because a drag can cross the wall.
   */
  const leaves = (x, z) => (laying ? lay : (insideStore(L, x, z) ? T.FLOOR : T.GRASS));
  const painted = groundIndex(L);

  // What the pads have now, so the stroke can be judged against what it would
  // leave rather than against each cell in isolation. Painting over the last
  // bay is only a consequence when it was the last one.
  const padWas = new Map(PAD_KINDS.map((k) => [k, 0]));
  const padLost = new Map(PAD_KINDS.map((k) => [k, 0]));
  for (const k of PAD_KINDS) padWas.set(k, padCells(L, k).length);

  let changed = 0;
  let bared = 0;
  for (const c of cells) {
    const x = Math.round(c.x);
    const z = Math.round(c.z);
    if (x < 1 || z < 1 || x >= L.w - 1 || z >= L.h - 1) return no('off the edge of the world');

    const ground = tileAt(L, x, z);
    const was = groundKindOfTile(ground);
    const want = leaves(x, z);

    // UNDER A CONVEYOR IS STILL GROUND, and this is the one cell where a stroke
    // changes the look without changing the tile.
    //
    // A belt stamps `T.BELT`, which is not a ground kind — so `was` is null and
    // the rule below read it as busy, the same answer it gives a bed or a wall.
    // That is right about everything else it covers and wrong about a track: a
    // conveyor is not a floor covering, it is a rail set INTO whatever is
    // already there, and the renderer draws the cell as the ground it lies on.
    // What it cost was that a run laid across your parquet could never be
    // parquet again — you would have to tear the belt up to redecorate under it
    // and rebuild it afterwards, which is a lot of ceremony for a colour.
    //
    // The stamp has to survive, because a non-blocking fixture is refused a
    // shared cell by its TILE and nothing else — so `T.BELT` going away is a
    // second belt on the same square. That is what makes this a look-only
    // stroke: the design lands in the overlay, `compose` re-stamps the tile
    // after the ground layer, and the cell comes back a belt standing on
    // parquet.
    //
    // Only the ground that was already there, though. The tile cannot move, so
    // laying a delivery bay here would paint a strip that looks like a pad, is
    // not one, and never will be — which is a lie you can see. Indoors that
    // means floor and outdoors it means lawn, read the way `leaves` reads it.
    if (ground === T.BELT) {
      const base = insideStore(L, x, z) ? T.FLOOR : T.GRASS;
      if (laying && lay !== base) {
        return no(base === T.FLOOR
          ? 'only floor goes under a conveyor'
          : 'only ground goes under a conveyor');
      }
      // The design is the only thing that can differ, so it is the whole test —
      // asking whether the TILE moved would report every cell of a run as
      // changed on every stroke and charge for all of them, for ever.
      if ((painted.get(`${x},${z}`) ?? null) !== (laying ? piece : null)) changed++;
      continue;
    }

    if (laying) {
      // Only ever over ground. Everything else a cell can be made of is
      // something with a job of a different sort — a bed, the path out to the
      // fields, a wall — and paving one over would take that job away silently,
      // with no fixture removed and nothing to put back.
      if (ground !== T.GRASS && was == null) return no(groundIsBusy(ground));
      // Restyling counts. Ground that is already this kind still changes hands
      // when the design differs, which is most of what this tool is for —
      // asking only whether the TILE moved would report a whole shop re-tiled
      // as "nothing to do".
      if (ground !== want || (painted.get(`${x},${z}`) ?? null) !== piece) changed++;
    } else {
      if (was == null) continue;                     // nothing to take up
      // ...and neither is ground that is ALREADY what taking it up leaves.
      // Every cell in the world is a kind now that the lawn has a row, so `was`
      // stopped being the whole test the day grass got one: a drag of the eraser
      // across a field would otherwise report every cell of it as a change,
      // charge for the stroke, and warn about the holes it left in a shop where
      // nothing moved. The design is the real question — bare lawn is the bare
      // ground this stroke produces, and lawn somebody painted is not. Indoors
      // `want` is floor, so plain shop floor is the same no-op in here that
      // plain grass is outside, and an eraser dragged across a bare aisle
      // charges nothing and warns about nothing.
      if (ground === want && (painted.get(`${x},${z}`) ?? null) == null) continue;
      // See above: this would drop the fixture rather than strand it.
      if (blockedAt(L, x, z)) return no('something is standing on it');
      changed++;
    }

    if (ground === want && was === kind) continue;
    // Two consequences, counted the same way in both directions: a cell that
    // ends up indoors and is not floor is one nothing can ever be built or dug
    // on, and a pad cell this stroke paints over is one that pad no longer has.
    if (was && was !== kind && padWas.has(was)) padLost.set(was, padLost.get(was) + 1);
    if (want !== T.FLOOR && insideStore(L, x, z)) bared++;
  }

  if (!changed) return { ok: true, unchanged: true };

  const warns = [];

  // Losing the last of a pad. Allowed — the whole point of the pads being
  // paintable is that you may move them, and moving one is two strokes with a
  // moment in between where you own none. But orders land on the bay and hands
  // are cleared at the drop-off, so a shop with neither is one where `order`
  // has nowhere to put a pallet, and that is worth being told before rather
  // than discovering it at the wholesaler.
  for (const k of PAD_KINDS) {
    if (padWas.get(k) > 0 && padLost.get(k) >= padWas.get(k)) warns.push(GROUND[k].lastGone);
  }

  // Bare ground indoors is a cell nothing can ever use: a shelf needs floor and
  // a bed needs to be outdoors, so it is not a patch of garden in your shop, it
  // is a hole. Allowed, because knocking your own floor out is a move and the
  // sim copes with it perfectly well — people walk over it. A stockroom floored
  // as bay is the same shape of hole, deliberately: it is a room for crates.
  if (bared) {
    warns.push(bared === 1
      ? 'that leaves a cell indoors that nothing can be built or dug on'
      : `that leaves ${bared} cells indoors that nothing can be built or dug on`);
  }

  return warns.length ? { ok: true, warn: warns.join('; ') } : { ok: true };
}

const groundIsBusy = (ground) => {
  if (ground === T.PLOT) return 'there is a bed there — clear it first';
  // T.PATH used to be refused here — "that is the path out to the fields" — and
  // that line retired with `GROUND.path`. It is a kind now, so `was` answers for
  // it above and this is never reached with one: the strip the generator lays is
  // ground you could have painted, and therefore ground you may paint over.
  return 'you can only lay ground over bare grass';
};

/**
 * Every conveyor cell in a layout — belts and loaders alike.
 *
 * One list, because a loader IS a belt as far as anything that moves goods is
 * concerned. Two lists would mean every hand-off asking two questions, and the
 * day somebody forgot the second one a crate would stop dead at every loader.
 */
export const CONVEYOR_KINDS = ['belt', 'arm', 'sorter', 'under'];

/**
 * The kinds a DRAG lays a line of.
 *
 * Not the same set, and the difference is the tunnel. A run is laid by dragging
 * because a belt is one cell repeated; a tunnel is two mouths with a gap that
 * has to stay empty, so dragging one lays a mouth on every square of the very
 * span the piece exists to give back — which stamps `T.BELT` down the whole
 * line, and the floor brush then refuses the ground you were promised.
 */
export const RUN_KINDS = ['belt', 'arm', 'sorter'];

/**
 * How many cells one drag of conveyor may lay.
 *
 * The same argument `GROUND_STROKE_MAX` makes and the same 4KB inbound cap
 * behind it: the wire carries two ends and the server re-runs the generator, so
 * this is a bound on the WORK rather than on the message. Sixty-four is about
 * two laps of a shop, which is more than anybody draws in one gesture.
 */
export const BELT_RUN_MAX = 64;

/**
 * How far out of a loader's own centre its spur reaches, in tiles.
 *
 * Shared because a spur is not decoration: it is a length of track the SIM walks
 * a crate along and the RENDERER lays rails under, and the two agreeing is the
 * whole of what makes a box look like it is on the belt rather than beside it.
 * Kept here rather than in either, for the reason `anchorTile` is — the day they
 * disagree, nothing errors and nothing logs, the crate simply floats.
 *
 * Two numbers because the split is what is standing there. Onto a pad or bare
 * floor it ends on the CENTRE of that tile — a box is set down on a square, and
 * a run that stopped anywhere else left the crate straddling a boundary with
 * its track carrying on past it, which reads as a belt that overshot. Into a
 * unit it stops just inside, because the unit's own mesh fills that square and
 * track drawn under it is track nobody will ever see.
 */
export const SPUR_UNIT_REACH = 0.66;
export const SPUR_OPEN_REACH = 1;

/**
 * The cells one drag of conveyor lays, in the order a crate would travel them.
 *
 * An L rather than a straight line — the long axis first, then the short — which
 * is the shape you are actually drawing when you take a belt round a shop, and
 * it means a loop is four drags instead of eight. The corner falls out of the
 * facings and needs no piece, exactly as it does when you lay them one at a
 * time.
 *
 * Each cell FACES THE NEXT ONE, which is the whole reason a belt wants a drag:
 * the direction of the gesture is the direction of the run, unambiguously, and
 * it is the one place in this game where that is true. The last cell keeps the
 * facing it arrived with, or a run would end pointing at whatever rot 0 is.
 *
 * `rot` is what a cell faces when the gesture has not said — which is the seed
 * of the walk, and therefore the answer for a drag of ONE. That case is not an
 * edge case, it is how you place a single belt: press, release, no travel, no
 * direction. Seeded at a literal 0 it ignored R entirely, so the one tool in
 * the game whose whole point is which way it points was also the only one that
 * could not be turned before it was put down — and R visibly turned the ghost
 * while it did it, because the ghost is drawn from the armed rotation and the
 * placement was not.
 *
 * The far end is the POINTER's, never the tail of this list — CLAUDE.md's scar
 * about `edgeRun` — so the caller sends what it aimed at and the server runs
 * this same function against it. `rot` goes over the wire for exactly the same
 * reason: it is an input to this generator, so a server that defaulted it would
 * lay a different run from the one the ghost drew.
 */
export function beltRunCells(from, to, max = BELT_RUN_MAX, rot = 0) {
  if (!from) return [];
  const end = to ?? from;
  const dx = end.x - from.x;
  const dz = end.z - from.z;
  const cells = [{ x: from.x, z: from.z }];
  const step = (n, ax) => {
    const sign = Math.sign(n);
    for (let i = 0; i < Math.abs(n) && cells.length < max; i++) {
      const last = cells[cells.length - 1];
      cells.push({ x: last.x + (ax === 'x' ? sign : 0), z: last.z + (ax === 'z' ? sign : 0) });
    }
  };
  if (Math.abs(dx) >= Math.abs(dz)) { step(dx, 'x'); step(dz, 'z'); }
  else { step(dz, 'z'); step(dx, 'x'); }

  const dirs = [0, 1, 2, 3].map((r) => {
    const a = anchorTile(0, 0, r);
    return { r, x: a.x, z: a.z };
  });
  let last = rot4(rot);
  return cells.map((c, i) => {
    const nxt = cells[i + 1];
    if (nxt) {
      const d = dirs.find((v) => v.x === Math.sign(nxt.x - c.x) && v.z === Math.sign(nxt.z - c.z));
      if (d) last = d.r;
    }
    return { x: c.x, z: c.z, rot: last };
  });
}

/** A cell whose pass-through is DERIVED rather than being its own `rot`. */
export const derivedFlow = (kind) => kind === 'arm' || kind === 'sorter';

export function conveyorsOf(L) {
  return [...(L?.belts ?? []), ...(L?.arms ?? []), ...(L?.sorters ?? []), ...(L?.unders ?? [])];
}

/**
 * How far a tunnel reaches, in cells between the two mouths.
 *
 * Short on purpose. Far enough to duck under an aisle, a wall, or a run's own
 * outbound leg — which is the whole complaint it exists to answer — and nowhere
 * near far enough to be a portal. Unlimited range makes every other piece in
 * this document pointless: you would lay one mouth on the dock and the other at
 * the shelf and never build a run again.
 */
export const TUNNEL_SPAN = 4;

/**
 * The far mouth this one hands to, or null if it is the far mouth itself.
 *
 * Both ends are laid facing the way the goods travel, so "am I an entry" is the
 * same question as "is there another mouth ahead of me, pointing the same way".
 * Nothing is stored and nothing is paired at build time — see `BUILD_KINDS.under`
 * for why a partner id would not survive the R key.
 *
 * The NEAREST one wins, so three mouths in a line are two tunnels rather than
 * one that skips the middle — otherwise laying a third would silently re-route
 * the pair you already had.
 */
export function tunnelExit(L, cell) {
  if (!cell || cell.kind !== 'under') return null;
  const step = anchorTile(cell.x, cell.z, cell.rot ?? 0);
  const dx = step.x - cell.x;
  const dz = step.z - cell.z;
  for (let i = 1; i <= TUNNEL_SPAN + 1; i++) {
    const x = cell.x + dx * i;
    const z = cell.z + dz * i;
    const other = (L?.unders ?? []).find((u) => u.x === x && u.z === z);
    if (other) return (other.rot ?? 0) === (cell.rot ?? 0) ? other : null;
  }
  return null;
}

/** The conveyor cell standing on this tile, if any. */
export function conveyorAt(L, x, z) {
  const cx = Math.round(x);
  const cz = Math.round(z);
  return conveyorsOf(L).find((c) => c.x === cx && c.z === cz) ?? null;
}

/**
 * Which way the goods go, for every conveyor cell in a layout, resolved once.
 *
 * A belt points where it points. A LOADER does not, and that inversion is what
 * makes one usable: a loader carries a belt's deck, so the first thing anybody
 * does is aim it at the shelf they want stocked — and if that were its
 * pass-through, aiming it at the shelf would break the run. Everybody did it.
 *
 * So `rot` on a loader means WHICH SIDE IT UNLOADS INTO, and where the crate
 * goes next is derived. The derivation cannot be done cell by cell, and that is
 * the thing worth knowing before touching this: a loader's neighbours may be
 * loaders, whose answers are also derived, so asking them is circular. Refusing
 * to ask was the first shape and it is right for a loader with a belt on either
 * side and wrong for every run MADE of loaders — which is what an aisle becomes
 * once each cell is stocking a shelf. Nobody in a row of four has a feeder,
 * nobody carries straight on, and the run bends wherever rotation order points.
 * Asking recursively was the second, and it is worse: a guard set that answers
 * "unknown" reads as "open", so the far end of a straight run resolves BACKWARDS
 * and the two halves meet in the middle.
 *
 * The answer is that flow has a source. Every plain belt knows its own
 * direction, so the resolution is a walk FORWARD from the belts: each cell hands
 * to the next, and a loader reached that way has a feeder — which is all it
 * needed to know. Straight on if it can, else a plain belt over another loader
 * (a belt carries information; somebody aimed it), else rotation order.
 *
 * Loaders with no belt anywhere upstream — a ring made entirely of them — fall
 * back to the old cell-by-cell guess. That shop is degenerate by construction
 * and the flow marks are what say so.
 *
 * Computed once per layout object and cached against the two arrays it is made
 * of, because it is walked twenty times a second by `stepBelts` and again by the
 * renderer. A re-flow builds a new layout, which is what invalidates it.
 *
 * In `shared/` because two things have to agree about it exactly — the sim that
 * moves the crate and the renderer that draws the path through the cell — and a
 * renderer with its own idea of where a belt goes is a picture of a shop that
 * works differently from the one you are playing.
 */
const FLOW = new WeakMap();

function conveyorFlow(L) {
  const belts = L?.belts ?? [];
  // Loaders and sorters together: both derive their pass-through, and the only
  // difference is that a sorter also keeps one side back for its branch.
  const arms = [...(L?.arms ?? []), ...(L?.sorters ?? [])];
  const unders = L?.unders ?? [];
  const had = FLOW.get(L);
  if (had && had.belts === belts && had.arms === arms.length
    && had.armsRef === (L?.arms ?? []) && had.sortRef === (L?.sorters ?? [])
    && had.underRef === unders) return had.map;

  const cells = [...belts, ...arms, ...unders];
  const at = new Map(cells.map((c) => [`${c.x},${c.z}`, c]));
  const map = new Map();

  /** This cell's conveyor neighbours, with which quarter turn each lies on. */
  const around = (c) => {
    const out = [];
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(c.x, c.z, r);
      const other = at.get(`${n.x},${n.z}`);
      if (other) out.push({ x: n.x, z: n.z, r, arm: other.kind === 'arm', cell: other });
    }
    return out;
  };
  /** Is this neighbour known to hand TO us? Then it is not somewhere to hand on. */
  const feedsUs = (o, c) => {
    const to = map.get(o.cell.id);
    return !!to && to.x === c.x && to.z === c.z;
  };
  /**
   * Is this option a straight continuation — the cell opposite it also being a
   * conveyor? That is what tells a run apart from a spur, and it is the only
   * handle a chain made ENTIRELY of loaders has.
   */
  const throughR = (c, r) => {
    const b = anchorTile(c.x, c.z, rot4(r + 2));
    return at.has(`${b.x},${b.z}`);
  };
  const choose = (c, backR) => {
    // A sorter's `rot` side is its BRANCH, never its straight-on. Without this
    // the derivation would happily pick the branch as the pass-through and the
    // piece would have one output that it used twice.
    const branch = c.kind === 'sorter' ? anchorTile(c.x, c.z, c.rot ?? 0) : null;
    const open = around(c).filter((o) => !feedsUs(o, c)
      && !(branch && o.x === branch.x && o.z === branch.z));
    if (!open.length) return null;
    if (backR !== null) {
      const straight = open.find((o) => o.r === backR);
      if (straight) return { x: straight.x, z: straight.z };
    }
    // Carry the LINE on before preferring a belt. A column of loaders with no
    // plain belt anywhere in it has nothing to seed the walk, and "hand to the
    // belt beside you" is then the answer every cell of it gives independently —
    // which is a whole run deciding, one cell at a time, to empty itself
    // sideways into the line next door. Deleting one belt out of a column did
    // exactly that.
    const pick = open.find((o) => throughR(c, o.r))
      ?? open.find((o) => !o.arm)
      ?? open[0];
    return { x: pick.x, z: pick.z };
  };

  // Seed: every plain belt answers for itself.
  const queue = [];
  for (const b of belts) {
    map.set(b.id, anchorTile(b.x, b.z, b.rot));
    queue.push(b);
  }

  // ...and so does a tunnel mouth, which is the whole of what makes one work.
  //
  // An entry hands to the far mouth rather than to the cell in front of it, and
  // an exit is an ordinary belt pointing the way it was laid. Both answer for
  // themselves, so the walk below reaches loaders on the far side exactly as it
  // reaches them through a straight — without this an entry's `next` is null,
  // which is the end of a run as far as every derived cell downstream is
  // concerned: they keep their feeders, lose their flow, and draw as a working
  // belt that never delivers.
  for (const u of unders) {
    const far = tunnelExit(L, u);
    map.set(u.id, far ? { x: far.x, z: far.z } : anchorTile(u.x, u.z, u.rot ?? 0));
    queue.push(u);
  }

  // ...and a loader AIMED AT A CONVEYOR answers for itself too.
  //
  // `rot` on a loader means the side its output goes to, and until now that only
  // ever meant a shelf (stock it first) or bare ground (set the box down there)
  // — the pass-through was always derived, which is right for a cell sitting IN
  // a run and leaves you no way at all to say "this one feeds that line". A
  // loader taking off a stocker's shelf and injecting into a loop beside it is
  // an ordinary thing to build and there was no rotation that would do it.
  //
  // Never onto its own feeder, though: a belt already resolved as pointing at
  // this loader would make the pair a two-cell tug of war, which is a run that
  // dead-ends in the middle of itself and draws exactly like a working one.
  for (const a of arms) {
    // Loaders only. A sorter's `rot` is the branch, so reading it as the output
    // here would make every sorter in the shop a belt pointing sideways.
    if (a.kind === 'sorter') continue;
    const f = anchorTile(a.x, a.z, a.rot ?? 0);
    const other = at.get(`${f.x},${f.z}`);
    if (!other) continue;
    // ...and only ever into a PLAIN BELT, which is the whole of what this
    // shortcut was ever for and the only case it can be right about.
    //
    // What it exists to allow is a loader taking stock off a shelf and injecting
    // it into a line beside it, and a line is a belt: somebody aimed that belt,
    // so the direction is declared and there is no argument to have. Aimed at
    // anything whose own flow is DERIVED, the shortcut is a guess that wins over
    // the walk — and the two disagree in the two ways that matter.
    //
    // At a junction it deletes the branch. Aiming a loader at the sorter beside
    // it is how everybody says "this line comes off there", and read as an
    // output it says the opposite — that the loader feeds the junction. Since
    // `conveyorBranches` drops any neighbour whose flow points back, the one act
    // meant to join the branch on is the act that disqualifies it, and the
    // sorter ends up with no branch at all.
    //
    // And loader-to-loader it PING-PONGS. A row of them aimed along the aisle
    // each self-answers at its neighbour, so a crate the junction pushes into
    // the end of the row is handed straight back the way it came: one cell out,
    // one cell home, for ever. It reads as the branch rejecting the box.
    //
    // Left unseeded, the forward walk reaches the whole chain from whatever
    // feeds it and derives every cell of it in the one consistent direction,
    // which is the answer the walk exists to give.
    if (other.kind !== 'belt') continue;
    const back = map.get(other.id);
    if (back && back.x === a.x && back.z === a.z) continue;
    map.set(a.id, { x: f.x, z: f.z });
    queue.push(a);
  }

  // ...and walk forward. A loader reached from something that hands to it is a
  // loader with a feeder, which is the one fact the derivation was missing.
  while (queue.length) {
    const c = queue.shift();
    // BOTH ways out of a junction. A sorter that only propagated its straight-on
    // would leave everything down its branch unseeded — and the cells that then
    // fall back to the per-cell guess are a whole line of loaders that quietly
    // decide, one by one, to hand sideways into the run next door.
    const ways = [map.get(c.id)];
    const br = c.kind === 'sorter' ? anchorTile(c.x, c.z, c.rot ?? 0) : null;
    if (br && at.has(`${br.x},${br.z}`)) ways.push(br);
    for (const to of ways) {
      if (!to) continue;
      const next = at.get(`${to.x},${to.z}`);
      if (!next || !derivedFlow(next.kind) || map.has(next.id)) continue;
      const fromR = [0, 1, 2, 3].find((r) => {
        const a = anchorTile(next.x, next.z, r);
        return a.x === c.x && a.z === c.z;
      });
      map.set(next.id, choose(next, fromR === undefined ? null : rot4(fromR + 2)));
      queue.push(next);
    }
  }

  // Anything the walk never reached has no belt upstream of it at all. Resolve
  // one, then PROPAGATE from it the same way — otherwise every cell of a
  // beltless chain answers independently and they disagree with each other.
  for (const c of arms) {
    if (map.has(c.id)) continue;
    map.set(c.id, choose(c, null));
    queue.push(c);
    while (queue.length) {
      const q = queue.shift();
      const ways = [map.get(q.id)];
      const b2 = q.kind === 'sorter' ? anchorTile(q.x, q.z, q.rot ?? 0) : null;
      if (b2 && at.has(`${b2.x},${b2.z}`)) ways.push(b2);
      for (const to of ways) {
        if (!to) continue;
        const next = at.get(`${to.x},${to.z}`);
        if (!next || !derivedFlow(next.kind) || map.has(next.id)) continue;
        const fromR = [0, 1, 2, 3].find((r) => {
          const a = anchorTile(next.x, next.z, r);
          return a.x === q.x && a.z === q.z;
        });
        map.set(next.id, choose(next, fromR === undefined ? null : rot4(fromR + 2)));
        queue.push(next);
      }
    }
  }

  FLOW.set(L, {
    belts,
    arms: arms.length,
    armsRef: L?.arms ?? [],
    sortRef: L?.sorters ?? [],
    underRef: unders,
    map,
  });
  return map;
}

/** Which cell this conveyor hands its crate to — see `conveyorFlow`. */
export function conveyorNext(L, cell) {
  if (!cell) return null;
  // A mouth is the one kind that is neither: its answer is its own `rot`, and
  // then it is a question about how FAR. Asked here rather than left to the
  // flow map because a non-derived kind never consults that map at all — which
  // is what an entry handing to the cell in front of it looks like, and it
  // draws as a tunnel that is simply a short belt.
  if (cell.kind === 'under') {
    const far = tunnelExit(L, cell);
    if (far) return { x: far.x, z: far.z };
    return anchorTile(cell.x, cell.z, cell.rot);
  }
  if (!derivedFlow(cell.kind)) return anchorTile(cell.x, cell.z, cell.rot);
  return conveyorFlow(L).get(cell.id) ?? null;
}

/**
 * A sorter's other way out — the side its `rot` names.
 *
 * Null for everything else, and null for a sorter whose branch has nothing on
 * it, because a branch that leads nowhere is not a decision: the piece is a belt
 * that cost more, and `stepBelts` should carry straight on rather than jamming
 * against a wall it was pointed at.
 */
export function conveyorBranch(L, cell) {
  if (!cell || cell.kind !== 'sorter') return null;
  const b = anchorTile(cell.x, cell.z, cell.rot ?? 0);
  return conveyorAt(L, b.x, b.z) ? b : null;
}

/**
 * ...and every other way out it has, which is what makes it a four-way.
 *
 * A junction with exactly two ways out is a junction that only helps when the
 * shape you wanted was a T. Standing one where four lines meet — which is the
 * ordinary thing to draw and the first thing anybody tries — it would ignore two
 * of them, and the two it ignored would look connected: they are conveyor cells
 * touching a conveyor cell, with a green mark on the join.
 *
 * So every neighbouring cell that is not its straight-on and is not feeding it
 * is a way out. `rot` stays FIRST, which is what keeps it meaningful: it is the
 * side the blade is drawn across and the side a tie goes to.
 *
 * Never back onto a feeder. That would be a two-cell tug of war, and at a
 * junction it is the likely one — four neighbours, and half of them are usually
 * pointing in.
 */
export function conveyorBranches(L, cell) {
  if (!cell || cell.kind !== 'sorter') return [];
  const straight = conveyorNext(L, cell);
  const named = anchorTile(cell.x, cell.z, cell.rot ?? 0);
  const out = [];
  for (const r of [0, 1, 2, 3]) {
    const n = anchorTile(cell.x, cell.z, r);
    const other = conveyorAt(L, n.x, n.z);
    if (!other) continue;
    if (straight && n.x === straight.x && n.z === straight.z) continue;
    // The side you AIMED it at is a branch full stop — the one thing on this
    // piece the player said out loud, and it outranks every derivation here.
    //
    // It did not, and that is what made a splitter unusable. The test below
    // drops any neighbour whose flow comes back at us, which is right for the
    // three incidental sides and catastrophic for the named one: a loader is
    // the natural thing to start a branch with, aiming it at the junction is
    // how you say the two are joined, and a loader aimed at a conveyor takes
    // that as its own output — so the act of connecting the branch is what
    // deleted it. No blade drawn, nothing ever diverted, and a run that looks
    // wired the whole time. Nobody could find that from playing.
    //
    // A DECLARED flow still wins, because a plain belt's rotation is the player
    // speaking too and two cells pointing at each other is a genuine tug of war
    // rather than a derivation artefact. Only that one case is refused.
    const isNamed = n.x === named.x && n.z === named.z;
    const to = conveyorNext(L, other);
    const back = to && to.x === cell.x && to.z === cell.z;
    if (back && (!isNamed || !derivedFlow(other.kind))) continue;
    out.push({ x: n.x, z: n.z });
  }
  // The side `rot` names goes first — a tie is settled by what you aimed it at.
  out.sort((a, b) => (a.x === named.x && a.z === named.z ? -1 : 0)
    + (b.x === named.x && b.z === named.z ? 1 : 0));
  return out;
}

/**
 * Every cell a crate put on this one would visit, in order, ending wherever the
 * run ends.
 *
 * Cycle-guarded rather than depth-capped, because a ring of belt is a legal and
 * ordinary thing to build — `beltOrder` already says so — and a walk that ran
 * off the end of one would hang the tick loop rather than draw a wrong picture.
 *
 * This is the function that lets anything ask *what is down there* without
 * knowing about belts: which units a box would be offered to, whether the line
 * goes anywhere at all. One walk, in `shared/`, for the same reason
 * `conveyorNext` is here — the sim routes a crate down it and the renderer draws
 * the same line, and two answers would be a picture of a different shop.
 */
export function conveyorRun(L, cell) {
  const out = [];
  const seen = new Set();
  // A queue rather than a walk, because a sorter has TWO ways out and "what is
  // down there" has to mean both of them. Asked of one branch only, a run that
  // splits would report half of what it serves — and the half it dropped is the
  // half somebody built the sorter for.
  const queue = cell ? [cell] : [];
  while (queue.length) {
    const at = queue.shift();
    if (!at || seen.has(at.id)) continue;
    seen.add(at.id);
    out.push(at);
    for (const to of [conveyorNext(L, at), ...conveyorBranches(L, at)]) {
      if (!to) continue;
      const on = conveyorAt(L, to.x, to.z);
      if (on && !seen.has(on.id)) queue.push(on);
    }
  }
  return out;
}

/**
 * A point some distance along a polyline, and the leg it landed on.
 *
 * THE ONE PIECE OF GEOMETRY THE WHOLE CONVEYOR HAS. A crate's entire state is
 * how far along its path it has got, and this is what turns that number into
 * somewhere on the floor — for a run, for a bend in the middle of one, for the
 * long hop between two tunnel mouths, and for the out-and-back a loader's spur
 * is. Corners fall out of it because the path bends; nothing anywhere needs to
 * know a corner exists.
 *
 * It replaced five writers of `crate.x`. Each was right on its own and they
 * disagreed at the seams — which a junction shows first, because a junction is
 * where a crate changes which of them it is in — and what that draws is a box
 * skipping. Not a bug in any of the five: a bug in there being five.
 */
export function alongPath(pts, at) {
  if (!pts?.length) return { x: 0, z: 0, leg: 0, k: 0 };
  if (pts.length === 1) return { x: pts[0].x, z: pts[0].z, leg: 0, k: 0 };
  let left = Math.max(0, at);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (seg <= 0) continue;
    if (left <= seg || i === pts.length - 1) {
      const k = Math.min(1, left / seg);
      return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, leg: i - 1, k };
    }
    left -= seg;
  }
  const last = pts[pts.length - 1];
  return { x: last.x, z: last.z, leg: pts.length - 2, k: 1 };
}

/**
 * Every conveyor in the shop, cut into LINES.
 *
 * THE UNIT IS THE LINE AND NOT THE TILE, which is the one decision this whole
 * subsystem rests on — Factorio's, for Factorio's reason (fff-176). A cell that
 * owns a crate, a clock and a decision is a cell that has to agree with the cell
 * next to it about all three, and the code where two cells meet is a SEAM: a
 * blocked box creeping forward, a corner special-cased, a junction asking a
 * different question when its exits are full than when they are free. Every one
 * of those was written honestly and they disagreed with each other at exactly
 * the places a player looks. Crates skipped at a T, refused to tween round a
 * bend, appeared at the end of a run and snapped back to the start of a cell
 * when a jam cleared. Each was fixed on its own and each fix exposed the next,
 * because the seams were not the bug — being made of seams was.
 *
 * A line is one object with an ordered path and a length in tiles. A crate on it
 * has ONE piece of state: how far along it has got. Everything else — where the
 * box is drawn, whether it is round the bend yet, which cell it counts as
 * standing on, whether the run has backed up — is derived from that number.
 *
 * WHERE A LINE ENDS is the whole of the rest of it, and there are three answers:
 *
 *   a **junction** is a line of its very own. A sorter chooses between ways out,
 *   so it cannot be a link in a chain that has already decided where it goes —
 *   it breaks lines apart rather than participating in one;
 *
 *   a **merge** starts one. Two lines feeding one cell need somebody to be told
 *   no, and the only place that can be said once is the cell they are both
 *   aiming at;
 *
 *   and a **terminus** ends one, which is a cell handing to nothing.
 *
 * A LOADER IS NOT ANY OF THOSE, and that is deliberate against the obvious
 * reading. It stands IN a run — "belts on the corners, loaders down the
 * straights" — so an aisle stocked by six of them is one line and not six, and
 * breaking at machines would put the seams straight back in the shape of shop
 * this feature exists for. What a loader does to a crate is hold it and send it
 * sideways down a spur, neither of which is a question about which way the line
 * goes.
 *
 * A ring has no terminus by definition, so a chain nothing starts is cut at an
 * arbitrary cell and joins itself: the line's exit is its own first cell, and a
 * crate that runs off the end reappears at the beginning of the same object.
 *
 * Cached against the four arrays it is made of, exactly as `conveyorFlow` is and
 * for the same reason — it is walked twenty times a second and can only change
 * when the building does.
 */
const LINES = new WeakMap();

export function conveyorLines(L) {
  const belts = L?.belts ?? [];
  const arms = L?.arms ?? [];
  const sorters = L?.sorters ?? [];
  const unders = L?.unders ?? [];
  const had = LINES.get(L);
  if (had && had.belts === belts && had.arms === arms
    && had.sorters === sorters && had.unders === unders) return had.out;

  const cells = [...belts, ...arms, ...sorters, ...unders];
  const grid = new Map(cells.map((c) => [`${c.x},${c.z}`, c]));
  const cellOf = (p) => (p ? grid.get(`${p.x},${p.z}`) ?? null : null);

  // Every way out of every cell, which is one for all of them but a junction.
  const ways = new Map();
  for (const c of cells) {
    const out = [];
    const n = cellOf(conveyorNext(L, c));
    if (n) out.push(n);
    if (c.kind === 'sorter') {
      for (const b of conveyorBranches(L, c)) {
        const o = cellOf(b);
        if (o && !out.some((w) => w.id === o.id)) out.push(o);
      }
    }
    ways.set(c.id, out);
  }
  const feeders = new Map();
  for (const c of cells) {
    for (const w of ways.get(c.id) ?? []) {
      if (!feeders.has(w.id)) feeders.set(w.id, []);
      feeders.get(w.id).push(c);
    }
  }

  /** Does a line have to BEGIN here — see the three answers above. */
  const opens = (c) => {
    if (c.kind === 'sorter') return true;
    const f = feeders.get(c.id) ?? [];
    if (f.length !== 1) return true;
    return f[0].kind === 'sorter';
  };

  const taken = new Set();
  const lines = [];
  const byCell = new Map();

  const cut = (start) => {
    const path = [];
    let c = start;
    while (c && !taken.has(c.id)) {
      taken.add(c.id);
      path.push(c);
      if (c.kind === 'sorter') break;
      const out = ways.get(c.id) ?? [];
      if (out.length !== 1) break;
      const n = out[0];
      if (opens(n)) break;
      c = n;
    }
    if (!path.length) return;
    const dist = [0];
    for (let i = 1; i < path.length; i++) {
      dist.push(dist[i - 1]
        + Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].z - path[i - 1].z));
    }
    const line = {
      id: path[0].id,
      cells: path,
      dist,
      len: dist[dist.length - 1],
      pts: path.map((p) => ({ x: p.x, z: p.z })),
      // Where it hands on. Per-crate at a junction, so the field is the list and
      // `sorterOut` picks; everywhere else there is exactly one answer.
      outs: ways.get(path[path.length - 1].id) ?? [],
      junction: path[0].kind === 'sorter',
    };
    lines.push(line);
    for (let i = 0; i < path.length; i++) byCell.set(path[i].id, { line, i });
  };

  for (const c of cells) if (opens(c) && !taken.has(c.id)) cut(c);
  // Anything left is in a ring — no cell in it opens a line, because every one
  // of them is fed by exactly one ordinary conveyor. Cut it anywhere: the walk
  // then comes back to where it started, and the line's exit is its own head.
  for (const c of cells) if (!taken.has(c.id)) cut(c);

  /**
   * ...and the order to step them in: DOWNSTREAM FIRST.
   *
   * The same argument the per-cell version made and the same bug it prevents,
   * one size up. Stepped the other way a line asks whether the line in front has
   * room before that one has moved, so a queue drains one gap per tick and a run
   * of boxes closes up like a slinky. There are far fewer seams to order now —
   * a straight aisle is one line however many cells it has — so this is a walk
   * over junctions and merges rather than over every square of belt.
   */
  const to = new Map();
  const from = new Map();
  for (const line of lines) {
    const outs = [];
    for (const w of line.outs) {
      const loc = byCell.get(w.id);
      if (!loc || outs.includes(loc.line)) continue;
      outs.push(loc.line);
      if (!from.has(loc.line.id)) from.set(loc.line.id, []);
      from.get(loc.line.id).push(line);
    }
    to.set(line.id, outs);
  }
  const order = [];
  const seen = new Set();
  const queue = lines.filter((l) => !(to.get(l.id) ?? []).length);
  const drain = () => {
    while (queue.length) {
      const l = queue.shift();
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      order.push(l);
      for (const f of from.get(l.id) ?? []) if (!seen.has(f.id)) queue.push(f);
    }
  };
  drain();
  for (const l of lines) {
    if (seen.has(l.id)) continue;
    queue.push(l);
    drain();
  }

  const out = { lines, byCell, order, feeds: from };
  LINES.set(L, { belts, arms, sorters, unders, out });
  return out;
}

/**
 * The units a crate put on this cell could still be unloaded into.
 *
 * Every loader from here DOWNSTREAM, and all four of its sides — because a
 * loader pours into whatever is beside it rather than into the one thing it
 * faces, and `rot` is only the side it tries first.
 *
 * Downstream and not the whole run, which is the half that makes this worth
 * having: a box put on the last cell before a wall is served by nothing, and a
 * hire who read the run as a set rather than as a direction would walk one to
 * the end of the line and stand there.
 */
/**
 * Everything a crate put on this cell could still be delivered INTO.
 *
 * Shelving, appliance hoppers and the skip, all from the same forward walk. A
 * loader that could only ever pour into a shelf is a loader that cannot automate
 * the half of the shop that is not shelves — five machines and a bin, in a shop
 * with eighteen units — and the walk that knows what is down there does not care
 * which of the three it finds.
 */
/**
 * Cached against the layout the way `conveyorFlow` is, and for a sharper reason:
 * this is a walk of the whole downstream network, and an IDLE loader asks it
 * every tick. `armSwing` needs it only to decide whether rubbish may ride, so a
 * shop with twenty loaders standing still was re-walking every cell of every run
 * twenty times a second — 62% of the entire sim, to answer a question whose
 * answer cannot change until somebody builds something.
 *
 * What it answers with is a list of LIVE records, so caching the list is not
 * caching the shop: `shelfAccepts` and `stationHopperRoom` still read the unit
 * as it is this tick. Only the shape of the network is remembered, and the same
 * three array identities `conveyorFlow` watches are what retire it — a re-flow
 * builds new ones, which is what makes a purchase or a demolition land.
 */
const MEETS = new WeakMap();

export function conveyorMeets(L, cell) {
  if (!cell) return { shelves: [], stations: [], bins: [] };
  const belts = L?.belts ?? [];
  const arms = L?.arms ?? [];
  const sorters = L?.sorters ?? [];
  let had = MEETS.get(L);
  if (!had || had.belts !== belts || had.arms !== arms || had.sorters !== sorters
    || had.shelves !== (L?.shelves ?? null) || had.stations !== (L?.stations ?? null)
    || had.bins !== (L?.bins ?? null)) {
    had = {
      belts,
      arms,
      sorters,
      shelves: L?.shelves ?? null,
      stations: L?.stations ?? null,
      bins: L?.bins ?? null,
      byCell: new Map(),
    };
    MEETS.set(L, had);
  }
  const hit = had.byCell.get(cell.id);
  if (hit) return hit;

  const out = { shelves: [], stations: [], bins: [] };
  const seen = new Set();
  const take = (list, from, key) => {
    for (const u of from ?? []) {
      if (u.x !== key.x || u.z !== key.z || seen.has(u.id)) continue;
      seen.add(u.id);
      list.push(u);
    }
  };
  for (const c of conveyorRun(L, cell)) {
    if (c.kind !== 'arm') continue;
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(c.x, c.z, r);
      take(out.shelves, L?.shelves, n);
      take(out.stations, L?.stations, n);
      take(out.bins, L?.bins, n);
    }
  }
  had.byCell.set(cell.id, out);
  return out;
}

export function conveyorServes(L, cell) {
  const units = L?.shelves ?? [];
  const out = [];
  const seen = new Set();
  for (const c of conveyorRun(L, cell)) {
    if (c.kind !== 'arm') continue;
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(c.x, c.z, r);
      const u = units.find((sh) => sh.x === n.x && sh.z === n.z);
      if (u && !seen.has(u.id)) { seen.add(u.id); out.push(u); }
    }
  }
  return out;
}

/**
 * The cells a fixture moves goods between, for the preview to draw.
 *
 * Deliberately NOT part of `workSpots`. That function answers "where does a
 * PERSON stand", and three callers act on it: the generator reserves those
 * tiles, `canPlace` warns when none is reachable, and `verify:layout` asserts
 * every fixture has one. A belt's output is none of those things — it is where
 * the next belt goes — so folding it in would make the shop keep clear exactly
 * the square you are trying to build on.
 *
 * `out` and `in` are quarter turns off the fixture's own `rot`, so the whole
 * table is two small integers and the geometry is `anchorTile`'s.
 */
export function flowSpots(kind, x, z, rot) {
  const flow = FIXTURES[kind]?.flow;
  if (!flow) return [];
  const out = [];
  if (flow.out != null) out.push({ ...anchorTile(x, z, rot + flow.out), role: 'out' });
  if (flow.in != null) out.push({ ...anchorTile(x, z, rot + flow.in), role: 'in' });
  return out;
}

/** Every fixture currently in the layout, as uniform placement specs. */
export function fixturesOf(L) {
  const out = [];
  for (const s of L.shelves ?? []) out.push({ kind: shelfKind(s.kind), ...s });
  for (const c of L.checkouts ?? []) out.push({ kind: 'checkout', ...c });
  for (const s of L.stations ?? []) out.push({ kind: 'station', ...s });
  for (const p of L.plots ?? []) out.push({ kind: 'plot', ...p });
  // `bins`, `belts` and `arms` were each missing from this list at some point,
  // and the failure is the same every time and is not an error: `freezeShell`
  // walks this to turn a generated shop into placements, and `whatThisBlocks`
  // walks it to decide whose working spot you are about to build over — so a
  // list that is absent here is a fixture that does not survive being stamped
  // and that nothing warns you about stranding.
  for (const b of L.bins ?? []) out.push({ kind: 'bin', ...b });
  for (const b of L.belts ?? []) out.push({ kind: 'belt', ...b });
  for (const a of L.arms ?? []) out.push({ kind: 'arm', ...a });
  for (const s of L.sorters ?? []) out.push({ kind: 'sorter', ...s });
  // Props carry their own kind, because there is more than one and they are not
  // told apart by which list they came out of.
  for (const p of L.props ?? []) out.push({ ...p });
  return out;
}

// ---------------------------------------------------------------------------
// The actual rule
// ---------------------------------------------------------------------------

/**
 * May this fixture go here?
 *
 * Two different answers, and the difference is the whole design.
 *
 * `ok: false` is physics — the tile is taken, or off the map, or a plot is
 * being dug in the shop. There is nowhere for the thing to be.
 *
 * `ok: true` with a `warn` is a *consequence*. Walling a shelf in, sealing the
 * doorway, standing a till where nobody can queue: all of that is allowed, and
 * it is allowed on purpose. A shelf nobody can reach simply never sells, and
 * the sim already copes — a shopper who can't path to a shelf writes it off and
 * picks another, one who can't reach the door leaves, staff cool down and find
 * another job. So the game says what it will cost you and lets you do it, which
 * is a game; refusing would be a level editor with opinions.
 *
 * The one caller that must still refuse a warning is the layout *generator* —
 * a procedurally furnished shop nobody can walk through is a bug, not a choice.
 * `canPlaceCleanly` is that caller's entry point.
 *
 * And there is a third question, which is not "may this go here" at all but "is
 * this still allowed to be where it already is". `canKeep` is that one, and
 * `keeping` is what it sets — see there for why the two cannot be the same rule.
 *
 * @param {object} L      the layout
 * @param {object} spec   { kind, x, z, rot }
 * @param {object} [opts] { ignoreId } — the fixture being moved, so it doesn't
 *                        block its own new position when they overlap.
 *                        { keeping } — judging something already standing.
 * @returns {{ok: boolean, reason?: string, warn?: string}}
 */
/**
 * One conveyor for another, in place — or null, meaning "no, for the ordinary
 * reason".
 *
 * Hoisted out of the indoor branch the day a run stopped being an indoor thing.
 * It reads `def.flow` rather than a list of kinds, so it is about the *shape* of
 * a fixture rather than about where the shop currently lets one stand, which is
 * what makes it survive the next move of that sort.
 *
 * You lay a run first and then decide which cells stock a shelf, so "delete the
 * belt, then place a loader on the hole" is two presses for one idea — and the
 * hole is a gap in a line you were looking at, which is the worst moment to be
 * asked to re-derive where you were.
 */
function conveyorSwap(L, def, spec, ground, x, z, ignoreId, keeping) {
  if (!def.flow || ground !== T.BELT || keeping) return null;
  const here = conveyorAt(L, x, z);
  if (!here) return null;
  // ITSELF, first — which is what makes a conveyor rotatable at all.
  //
  // `ignoreId` un-blocks the cell for the fixture being moved everywhere else
  // in here, and it could not reach this branch: a conveyor stamps `T.BELT` on
  // its own square, that stamp is what refuses a second one, and the stamp does
  // not know who laid it. So a loader asked to turn was refused on all four
  // facings, `rotateFixture` reported "nowhere for it to turn to", and the only
  // way to change one was to delete it and lay it again — which nothing
  // anywhere says, so what it reads as is R being a dead key on the one piece
  // whose whole job is which way it points.
  //
  // Before the kind test rather than folded into it, because the answer is
  // different: swapping a belt for a loader is a purchase and warns about what
  // it replaces, where turning a piece you already own costs nothing and has
  // nothing to say.
  if (here.id === ignoreId) return { ok: true };
  // Only between the two conveyor kinds, and never for the same kind: a belt
  // over a belt is a press that takes money and changes nothing.
  if (here.kind !== spec.kind) {
    return { ok: true, warn: `replaces the ${FIXTURES[here.kind]?.label?.toLowerCase() ?? 'belt'} that is there` };
  }
  return null;
}

export function canPlace(L, spec, { ignoreId = null, keeping = false } = {}) {
  const def = FIXTURES[spec.kind];
  if (!def) return no(`"${spec.kind}" is not something you can build`);

  const x = Math.round(spec.x);
  const z = Math.round(spec.z);
  if (x < 1 || z < 1 || x >= L.w - 1 || z >= L.h - 1) return no('off the edge of the world');

  if (isProp(spec.kind)) return canPlaceProp(L, def, x, z, ignoreId, keeping);

  // Two questions where there used to be one, because a tile used to answer
  // both. What the ground is made of is `tiles`; whether something already
  // stands on it is `blocked`. A plot digs the ground, so it asks about grass;
  // everything else stands on the floor.
  const ground = tileAt(L, x, z);
  const taken = blockedAt(L, x, z, ignoreId);

  /**
   * One conveyor for another, asked ONCE and asked FIRST.
   *
   * It used to be asked inside the "what is this ground made of" refusal, which
   * is where a belt is refused — `T.BELT` is in neither buildable set, and a
   * plain belt blocks nobody, so that is the only door it ever knocks on. A
   * loader and a sorter are housings you cannot walk through, so they are
   * refused one line EARLIER, by `blocked`, and never reached it.
   *
   * What that bought was a ladder with a rung missing in one direction: belt to
   * loader, fine; loader back to belt, or loader to tunnel, "something is
   * already there" — about a cell you own, holding a piece of the very run you
   * are drawing. And the two are the same gesture with the tool swapped, so it
   * reads as the tunnel tool being broken rather than as a rule about housings.
   *
   * Hoisted above `taken` rather than repeated beside it: the two refusals
   * BOTH mean "there is a conveyor here", which is the answer this function
   * wants, so a third copy is a third place for the next kind to be forgotten.
   */
  const swap = def.flow ? conveyorSwap(L, def, spec, ground, x, z, ignoreId, keeping) : null;

  // `where` is asked only of something being put down. Of something already
  // standing it is not a fact about the fixture at all — it is a fact about the
  // walls around it, and those move. See `canKeep`.
  if (def.where === 'indoor') {
    if (!keeping && !insideStore(L, x, z)) return no('that has to go inside the shop');
    if (swap) return swap;
    if (taken) return no('something is already there');
    if (!BUILDABLE_INDOOR.has(ground)) {
      return no(ground === T.DOOR ? 'not in the doorway' : 'something is already there');
    }
  } else if (def.where === 'any') {
    // Either side of the wall, on whatever that side is made of. Its own branch
    // rather than a third case bolted onto the two above, because both of those
    // are written as one place with one ground and one refusal — the `else` is
    // the PLOT rule wearing a general name, right down to the wording ("plots go
    // outside", "you can only dig into bare grass"). A kind that may go anywhere
    // fell into it and was told it could only be dug into grass, which reads as
    // the palette offering something the shop refuses.
    if (swap) return swap;
    if (taken) return no('something is already there');
    if (!BUILDABLE_INDOOR.has(ground) && !BUILDABLE_OUTDOOR.has(ground)) {
      return no(ground === T.DOOR ? 'not in the doorway' : 'something is already there');
    }
  } else {
    if (!keeping && insideStore(L, x, z)) return no('plots go outside, on the grass');
    if (taken) return no('something is already there');
    if (!BUILDABLE_OUTDOOR.has(ground)) return no('you can only dig into bare grass');
  }

  const warn = whatThisCosts(L, { ...spec, x, z }, def, { ignoreId });
  return warn ? { ok: true, warn } : { ok: true };
}

/**
 * May a decoration stand here?
 *
 * Much shorter than the fixture rule, and that is the point rather than an
 * omission. A prop stamps no tile, so it cannot cut a shelf off, cannot seal a
 * doorway and cannot leave a queue nowhere to form — every warning `canPlace`
 * has to reason about is about *occupying* a cell, and this doesn't. So there
 * are no soft answers here at all: what remains is genuine physics.
 *
 * One prop to a cell, though, and that is not fussiness. The pointer names a
 * cell (`fixtureAt`), so two things stacked on one is a menu you cannot open —
 * the same reason build mode aims at named targets rather than at whatever is
 * nearest. A cell holds one thing you can point at.
 */
function canPlaceProp(L, def, x, z, ignoreId, keeping = false) {
  if (!keeping && def.where === 'indoor' && !insideStore(L, x, z)) {
    return no('that has to go inside the shop');
  }
  // A prop stands *in* the cell, so the cell has to be somewhere a person could
  // stand. This is also what keeps one out of a shelf without a second rule.
  //
  // ...unless it HANGS, which is what `at` has said since props existed and
  // nothing had ever read. A pendant over an aisle is the whole point of a
  // ceiling fitting — the light wants to be over the goods, and the goods are
  // the one thing this test calls "already there" — so every cell worth hanging
  // one in was refused, and the refusal named the shelf you were deliberately
  // lighting. It reads as the game being wrong about what a lamp is, which it
  // was. Nothing else changes: `where: 'indoor'` above still keeps it in the
  // building, it still stamps no tile, and it still cannot share a cell with
  // another prop.
  if (def.at !== 'ceiling' && (!WALKABLE.has(tileAt(L, x, z)) || blockedAt(L, x, z, ignoreId))) {
    return no('something is already there');
  }
  const clash = (L.props ?? []).some((p) => p.id !== ignoreId && p.x === x && p.z === z);
  if (clash) return no('something is already there');
  return { ok: true };
}

/**
 * `canPlace`, for the one caller that cannot live with a warning: the layout
 * generator. It furnishes a shop nobody has looked at yet, so "you could seal
 * this off if you wanted to" is not an offer it can accept on your behalf.
 */
export function canPlaceCleanly(L, spec, opts = {}) {
  const r = canPlace(L, spec, opts);
  return r.ok && r.warn ? no(r.warn) : r;
}

/**
 * `canPlace`, for the question the re-flow actually asks: may this stay where it
 * already is?
 *
 * The third entry point, and it exists because "may this go here" and "may this
 * stay here" are different questions that looked like one. `compose` re-judges
 * every placement on every re-flow, and it was asking the *placement* rule — so
 * a rule about where you may PUT a shelf became a rule about where a shelf is
 * allowed to CONTINUE STANDING, and the difference is a bug that deleted
 * people's shops.
 *
 * `where` is the whole of it. Being indoors is not a property of a shelf, it is
 * a property of the walls around the shelf, and walls are a thing the player
 * moves. So knocking one hole in your wall un-enclosed the building, every
 * fixture in it was suddenly "outdoors", and every one of them failed
 * `canPlace` and was dropped — six shelves, a freezer and the till, refunded at
 * full price and gone, on a gesture the game had described as a warning. The
 * warning was even correct ("that leaves 8 fixtures standing outside"); what
 * was wrong was that standing outside was fatal.
 *
 * It is fatal nowhere else, deliberately. `whatThisUnroofs` has said since the
 * day enclosure arrived that putting your shelving out in the weather is
 * allowed and the sim copes — a shelf outdoors keeps its stock and keeps
 * selling, and what you lose is the right to build another one beside it. That
 * was true of everything except the one piece of code that could act on it.
 *
 * Everything else stays exactly as strict, because everything else is physics
 * that really can take a cell away: off the map, ground it cannot stand on,
 * something else already in it. Those are the cases `droppedPlacements` was
 * written for and they still drop.
 *
 * This is the same mistake as the `canPlaceCleanly` one directly above, one
 * layer further down: a rule written for a caller putting something down, asked
 * of a caller re-applying what is already there. Both times the symptom was a
 * fixture vanishing a tick after you touched something near it.
 */
export function canKeep(L, spec, opts = {}) {
  return canPlace(L, spec, { ...opts, keeping: true });
}

const no = (reason) => ({ ok: false, reason });

/**
 * What placing this here would cost you, or null if it costs nothing.
 *
 * Every one of these used to be a refusal. They are the same checks, asked as
 * "what happens" rather than "may I" — so the order matters only in that the
 * most specific answer should come out first.
 */
function whatThisCosts(L, spec, def, { ignoreId }) {
  const { x, z } = spec;
  // Where a person could stand, with the thing being moved treated as already
  // gone and the thing being placed treated as already there.
  const open = (tx, tz) => WALKABLE.has(tileAt(L, tx, tz))
    && !blockedAt(L, tx, tz, ignoreId)
    && !(tx === x && tz === z && def.blocks);

  // ---- can anything use it, facing that way? -----------------------------
  //
  // The indoor half is a rule about WHO uses the thing, not about the thing, so
  // it is asked of `where` rather than of every anchor. A shelf, a freezer, a
  // warmer, a till and an appliance are all `where: 'indoor'` and are all worked
  // from a spot a shopper or a hire reaches across the shop floor — turn one to
  // face out through your own back wall and it is furniture.
  //
  // A skip is the counter-example and the reason this is a `where` test: `bin`
  // is authored `where: 'any'` precisely because rubbish goes out the back, and
  // the back of the shop is outdoors. Nothing in the sim disagrees — `tidy`
  // walks somebody to `bin.useAt` through `findPath`, which has never cared
  // which side of a wall a tile is on. So the shop refused to shut up about the
  // one placement the kind exists for, and a warning that fires on the correct
  // answer is a warning nobody reads on the placement that is genuinely wrong.
  if (def.anchor) {
    const a = anchorTile(x, z, spec.rot ?? 0);
    if (!open(a.x, a.z)) return 'nothing can use it facing that way';
    if (def.where === 'indoor' && !insideStore(L, a.x, a.z)) {
      return 'it faces out of the shop — nobody will use it';
    }
  } else if (!FACING.some((f) => open(x + f.dx, z + f.dz))) {
    return 'nothing can get to it';
  }

  // ---- ...and does what it moves goods to and from actually exist? --------
  //
  // A warning rather than a refusal, on the house rule: a dead-ended belt is a
  // legitimate thing to build — you lay a run one cell at a time, so every belt
  // is a dead end for the moment between placing it and placing the next. What
  // it must not be is SILENT, because a broken junction and a working one are
  // the same dark rectangle, and the shop just quietly does nothing.
  if (def.flow) {
    const isBelt = (tx, tz) => (L.belts ?? []).some((b) => b.x === tx && b.z === tz)
      || (tx === x && tz === z);
    const holds = (tx, tz) => (L.shelves ?? []).some((sh) => sh.x === tx && sh.z === tz)
      || (L.stations ?? []).some((st) => st.x === tx && st.z === tz)
      || (L.bins ?? []).some((bn) => bn.x === tx && bn.z === tz);

    if (def.flow.out != null) {
      const o = anchorTile(x, z, (spec.rot ?? 0) + def.flow.out);
      if (!isBelt(o.x, o.z) && !holds(o.x, o.z)) {
        return spec.kind === 'belt'
          ? 'it runs into nothing — the next belt goes on the square it points at'
          : 'nothing in front of it to put goods into';
      }
    }
    if (def.flow.in != null) {
      const i = anchorTile(x, z, (spec.rot ?? 0) + def.flow.in);
      if (!isBelt(i.x, i.z)) return 'nothing behind it to take goods from';
    }
  }

  // An arm asks the same question of all four sides at once, because it works
  // between any two of them. Two warnings rather than one, since "it has
  // nothing to take from" and "it has nowhere to put things" are different
  // mistakes and telling somebody the wrong one sends them to the wrong side.
  // A loader sits in the run and unloads sideways, so what it needs beside it is
  // SHELVING. Without any it is a belt that cost four times as much — which is
  // a thing you may build (it still carries crates) and must be told about.
  if (def.works) {
    const around = FACING.map((f) => ({ x: x + f.dx, z: z + f.dz }));
    const unitish = (c) => (L.shelves ?? []).some((sh) => sh.x === c.x && sh.z === c.z);
    if (!around.some(unitish)) return 'no shelving beside it — it will just carry crates past';
  }

  // ---- ...and can anyone stand behind it and work it? ---------------------
  // A warning rather than a refusal, like everything else here: a till with its
  // back to a wall still takes money, because a *player* serves from anywhere
  // within reach (`Game.serve` checks a radius, not a tile). What it costs you
  // is staff — a hire walks to this spot and no other, so a till without one is
  // a till you have to work yourself, forever.
  if (def.behind) {
    const b = behindTile(x, z, spec.rot ?? 0);
    if (!open(b.x, b.z)) return 'nowhere to stand behind it — staff could never work it';
    if (!insideStore(L, b.x, b.z)) return 'its working side is outside the shop';
  }

  // ---- a till wants a queue ----------------------------------------------
  if (spec.kind === 'checkout') {
    const serve = anchorTile(x, z, spec.rot ?? 0);
    const clash = (L.checkouts ?? []).some((c) => c.id !== ignoreId
      && c.serveAt?.x === serve.x && c.serveAt?.z === serve.z);
    if (clash) return 'another till already serves that spot';
    // Measured against a shop with this till already standing in it, which used
    // to mean cloning the tile array. A mask is cheaper to say "and this one" to.
    const probe = { ...L, blocked: withBlocked(L, x, z) };
    // The same walk the line itself will take, so the warning cannot promise a
    // pile-up the lane then bends its way out of. A till in a corner used to be
    // warned about on the strength of a straight run it never had.
    const others = new Set((L.checkouts ?? [])
      .filter((c) => c.id !== ignoreId && c.serveAt)
      .map((c) => `${c.serveAt.x},${c.serveAt.z}`));
    const best = Math.max(...queueAxis(spec.rot ?? 0)
      .map((d) => queueLane(probe, serve, d, { claimed: others }).length - 1));
    if (best < 1) return 'no room for a queue — shoppers will pile up on one tile';
  }

  // ---- and what it cuts off ----------------------------------------------
  return whatThisBlocks(L, spec, def, ignoreId);
}

/**
 * A copy of the occupancy mask with one more cell taken.
 *
 * `removedTiles`, `baseTile` and `withTile` all lived here and all retired with
 * the stamp: there is no longer any difference between "what this tile is" and
 * "what this tile would be with nothing on it", because a tile never carried a
 * fixture in the first place. That is the simplification step 5 was for.
 */
function withBlocked(L, x, z) {
  const copy = Uint8Array.from(L.blocked ?? new Uint8Array(L.w * L.h));
  copy[z * L.w + x] = 1;
  return copy;
}

/**
 * Would putting this here cut something off — and if so, what?
 *
 * Returns the reason, or null when everything is still reachable. It answers
 * *which* thing rather than a flat yes/no because the two ways to fail read
 * completely differently to whoever is holding the shelf: one tile over is
 * where a shopper stands to reach the unit behind, and being told that "blocks
 * the way through" sends you looking for a corridor that was never the problem.
 *
 * The flood starts at the door, because that is where shoppers come in — a
 * pocket of floor nobody can walk to is not floor.
 *
 * **A warning is a DELTA, and it was an absolute for as long as this existed.**
 * The flood was run once, with the thing already standing there, and anything
 * it failed to reach was blamed on the placement. So one freezer with a crate
 * on its browse tile — a shop somebody had already half-blocked, which is a
 * move the game explicitly allows — made *every* ghost anywhere in the world
 * say "that would cut off a freezer you own". Including a plot out in the
 * middle of a field, which is where it was finally noticed, and including the
 * one placement that genuinely was about to seal something off: a warning that
 * is always on is a warning nobody reads.
 *
 * So both floods, and only a spot that was reachable *before* and isn't now.
 * The second one is lazy and usually free: the two masks differ by exactly the
 * one cell being taken, so a piece that blocks nothing — a plot, a decoration —
 * cannot change reachability at all and reuses the first flood outright. That
 * matters here, because this runs on every ghost frame and ~100k times in
 * `verify:layout`.
 */
function whatThisBlocks(L, spec, def, ignoreId) {
  // The flood runs over the *occupancy* mask now rather than a doctored copy of
  // the ground. The thing being moved has already left as far as this is
  // concerned — or a shelf could never be shuffled one square along — and the
  // thing being placed is treated as already standing there.
  const before = Uint8Array.from(L.blocked ?? new Uint8Array(L.w * L.h));
  if (ignoreId) {
    for (const f of fixturesOf(L)) {
      if (f.id === ignoreId) before[f.z * L.w + f.x] = 0;
    }
  }
  // Which is also the baseline: what the shop is like with this thing lifted
  // and not yet put down, which is exactly what the player is looking at.
  const after = def.blocks ? Uint8Array.from(before) : before;
  if (def.blocks) after[spec.z * L.w + spec.x] = 1;

  const flood = (blocked) => {
    const probe = { ...L, blocked };
    const seen = new Set([`${L.door.x},${L.door.z}`]);
    const stack = [[L.door.x, L.door.z]];
    while (stack.length) {
      const [cx, cz] = stack.pop();
      for (const f of FACING) {
        const nx = cx + f.dx;
        const nz = cz + f.dz;
        const k = `${nx},${nz}`;
        if (seen.has(k)) continue;
        if (SOLID.has(edgeBetween(probe, cx, cz, nx, nz))) continue;
        if (!isWalkableTile(probe, nx, nz)) continue;
        seen.add(k);
        stack.push([nx, nz]);
      }
    }
    return seen;
  };

  const seen = flood(after);
  // Paid for only when something is unreachable and this placement could be the
  // reason — so the common case, where nothing is cut off at all, runs one flood
  // exactly as it always did.
  let base = after === before ? seen : null;
  const key = (p) => `${Math.round(p.x)},${Math.round(p.z)}`;
  const reached = (p) => seen.has(key(p));
  const wasReached = (p) => {
    base ??= flood(before);
    return base.has(key(p));
  };
  // The one question every check below is really asking. Said as two floods
  // rather than folded into a single "reaches", because the checks that take
  // ANY of several tiles cannot be built out of a per-tile answer: a bay with
  // three cells already cut off and one good one is sealed by taking the good
  // one, and a predicate that calls the three "fine, they were already gone"
  // reports that as no change at all.
  const cutOff = (p) => !reached(p) && wasReached(p);
  const isHere = (p) => Math.round(p.x) === spec.x && Math.round(p.z) === spec.z;
  const label = (kind) => FIXTURES[kind]?.label.toLowerCase() ?? 'fixture';

  // Whatever you are placing has to be usable itself, and standing somewhere
  // walkable is not the same as standing somewhere you can walk *to*.
  //
  // `reached` and not `reaches`: these two are the exception to the delta, and
  // for the reason the delta exists. A thing you are about to put down has no
  // "before" — it wasn't anywhere — so nothing here can be somebody else's
  // pre-existing mess. Standing a shelf in a room you have sealed off deserves
  // to be told so every time, even though that room was already sealed.
  if (def.anchor) {
    const mine = anchorTile(spec.x, spec.z, spec.rot ?? 0);
    if (!reached(mine)) return 'you could never get round to that side of it';
  }
  if (def.behind) {
    const mine = behindTile(spec.x, spec.z, spec.rot ?? 0);
    if (!reached(mine)) return 'nobody could get round behind it to serve';
  }

  for (const f of fixturesOf(L)) {
    if (f.id === ignoreId) continue;
    if (f.kind === 'plot') {
      // A bed is worked from any side, so it only needs one of them — and it
      // has to have had one, or a bed you had already boxed in blames the next
      // thing you put down anywhere in the shop.
      const sides = FACING.map((d) => ({ x: f.x + d.dx, z: f.z + d.dz }));
      if (!sides.some(reached) && sides.some(wasReached)) {
        return 'that would leave a plot with no way in';
      }
      continue;
    }
    // Both sides of a counter, and the reason this reads them off the record
    // rather than recomputing from `rot`: a re-flow judges placements against a
    // half-built layout, and `serveAt` is what the till was actually laid with.
    // ...and the same filter, for the same reason: `L` is the shop before this
    // placement, so an end that is already another unit is not a spot this is
    // taking away. Without it, standing a shelf at the end of a run — which is
    // how a run of shelving gets built — reports "that is where you stand to
    // use the shelf behind it" about a tile nobody has ever stood on.
    for (const s of spotsOf(f, { layout: L })) {
      if (s.role === 'tend') {
        // Said differently on purpose. "Where you stand to use it" is wrong for
        // this side — you never do — and a player told that about a tile behind
        // a counter goes looking for a shelf that isn't there.
        if (isHere(s)) return `that is where your clerk stands to work the ${label(f.kind)}`;
        if (cutOff(s)) return `that would leave a ${label(f.kind)} nobody can get behind`;
        continue;
      }
      if (isHere(s)) return `that is where you stand to use the ${label(f.kind)} behind it`;
      if (cutOff(s)) return `that would cut off a ${label(f.kind)} you own`;
    }
  }

  if (cutOff(L.spawn)) return 'that would block the way through';
  // A pad is a region rather than a point now, so the question is whether ANY
  // of it is still reachable — walling off one corner of a big stockroom is a
  // choice, and sealing the whole thing is what this is here to catch.
  for (const k of PAD_KINDS) {
    const cells = padCells(L, k);
    if (cells.length && !cells.some(reached) && cells.some(wasReached)) {
      return `that would cut off the ${GROUND[k].label.toLowerCase()}`;
    }
  }
  return null;
}
