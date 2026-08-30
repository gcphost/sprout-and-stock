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

import { T, WALKABLE, DRIVABLE, BUILDABLE_INDOOR, BUILDABLE_OUTDOOR } from './tiles.js';
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
  shelf: {
    label: 'Shelf', blocks: true, where: 'indoor', rotates: true, anchor: 'browseAt', ends: true,
    arm: { pour: true, take: true },
  },
  freezer: {
    label: 'Freezer', blocks: true, where: 'indoor', rotates: true, anchor: 'browseAt', ends: true,
    arm: { pour: true, take: true },
  },
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
  warmer: {
    label: 'Hot Counter', blocks: true, where: 'indoor', rotates: true, anchor: 'browseAt', ends: true,
    arm: { pour: true, take: true },
  },
  checkout: {
    label: 'Till', blocks: true, where: 'indoor', rotates: true,
    anchor: 'serveAt', behind: 'tendAt',
  },
  station: {
    label: 'Appliance', blocks: true, where: 'indoor', rotates: true, anchor: 'useAt', ends: true,
    // Both ports, and it is the kind that makes the pair obvious: goods go into
    // the hopper and a finished tray comes off the other side.
    arm: { pour: true, take: true },
  },
  /**
   * The plot — a bed, and since the farm came indoors it is a bed that may
   * stand anywhere.
   *
   * `where: 'any'`, and the choice between that and `'indoor'` is the one
   * decision in docs/vats.md step 1. It is NOT stylistic. Every fixture in
   * every save is a placement at an absolute tile and there are live shops with
   * beds standing on grass right now; `compose` re-judges player placements on
   * every re-flow, and a re-flow fires on every wall segment of every drag. So
   * `'indoor'` would not migrate an outdoor farm, it would SHED AND REFUND it —
   * the first time somebody drew a wall. Money back, so nothing reads as
   * stolen, and what you watch is your farm disappearing because you built a
   * shed. That is `droppedPlacements` doing exactly what it is for, aimed at
   * the wrong target.
   *
   * `'any'` is the skip's flag (see `bin`), it strands nothing, and it means an
   * outdoor farm goes on working for anybody who wants one.
   */
  /**
   * THE RACK STANDS ON ITS CELL, WHERE THE BED WAS THE CELL.
   *
   * `blocks: false, rotates: false, anchor: null` was the bed's whole shape and
   * every word of it was right about soil: you stood ON the thing you were
   * picking, so it had no working spot because it *was* one, it could not turn
   * because a square of earth has no front, and a block of them was a field you
   * walked through. A grow tent has a front, a back and a door, and a waist-high
   * tent you stroll through is the thing that reads wrong.
   *
   * So it is the shelf's shape now, and the three flags move together — a
   * blocking fixture with no anchor is a thing nobody can reach, and an anchor
   * that cannot turn is a door in whichever direction the generator felt like.
   *
   * `ends: true` is the forgiving half and it is load-bearing rather than
   * generous. A bed has always been workable from wherever you were standing, so
   * making it front-only would strand every bed in every live save that happens
   * to have its neighbour on the side `rot` picked — a farm you own and cannot
   * pick. With ends, three of the four sides answer, which is a run of racks with
   * an aisle down it, exactly as a run of shelving is.
   *
   * `ground: T.PLOT` STAYS, and it is worth saying why it is not now redundant.
   * `blocked` refuses a second fixture on the cell, so the stamp looks like
   * belt-and-braces — but it is what `canPaintGround` reads to say "there is a
   * bed there, clear it first", and it is what keeps a rack off a conveyor and a
   * conveyor off a rack. The tile is still WALKABLE (`WALKABLE` in tiles.js);
   * what stops you is the same thing that stops you walking through shelving.
   */
  /**
   * ...AND THE WORD IS GROW RACK, WHICH IS WHAT THE BAR SAYS.
   *
   * `plot` is the id and "Grow Rack" is what somebody reads, the same split
   * `lawn`/Land draws one table down. The label was `Plot` — a codebase word
   * that appears nowhere a player can see it, because the palette draws a kind's
   * button from its `fixtures` ROW (`client/sections.js`) and the one offered
   * row is named Grow Rack. Nothing showed the mismatch until the goal chip
   * started naming what a rung opens: `opensAt` reads kind labels, so the HUD
   * promised a Plot over a Farm tab with no such button on it, which is
   * `shared/reveal.js`'s own "a card promising a Chiller over a bar that says
   * Freezer" arriving through the one word nobody had checked.
   *
   * It is the KIND's word rather than the piece's, so it has to stay true of a
   * second rack somebody draws tomorrow — and it is folded into a sentence in a
   * dozen places (`that would cut off 2 grow racks`, `replaces the grow rack`),
   * which is why it is the thing on the floor and not the tab it is filed
   * under. Do not "fix" it back to the id later.
   */
  plot: {
    label: 'Grow Rack', blocks: true, ground: T.PLOT, where: 'any', rotates: true,
    anchor: 'useAt', ends: true,
    // Take only. `armReap` picks a ripe rack and re-sows it; nothing has ever
    // poured anything INTO a bed, and a seed is not goods on a run.
    arm: { take: true },
  },
  /**
   * The pen — an animal, and the first thing in the game that produces goods
   * without anybody asking it to.
   *
   * Animals were CROPS until this existed, on the precedent that `chicken-coop`
   * had always been one, and every number about that worked. What did not work
   * is the sentence it made you say: you put down a raised bed, opened its seed
   * picker, and *sowed a cow* — then sowed the same cow again every time you
   * collected the milk. A bed is soil you turn over, and turning soil over is
   * the whole rhythm the plot exists for; an animal is a thing you buy once and
   * then look after, and the two only looked alike because a crop was the one
   * shape the game had for "wait, then collect".
   *
   * So a pen is a FIXTURE and there is exactly one kind of it. The seven
   * animals are seven `fixtures` rows — kinds are code, pieces are content —
   * which is what makes an eighth a row somebody authors rather than a branch
   * somebody adds. What differs between a beehive and a cattle pen is its art,
   * its price, what it makes and how fast, and not one of those is a rule.
   *
   * `blocks: true`, unlike the bed it replaces, and that is the honest answer
   * rather than the convenient one: a hutch is a thing standing on the ground,
   * where a bed IS the ground. It also keeps it out of `verify:catalog`'s
   * "either occupy your cell or be what the cell is made of" — a walk-over kind
   * with no `ground` stamp can be stacked on itself without limit.
   *
   * `where: 'any'`, which is the plot's rule and is about the same thing: the
   * farm came indoors (docs/vats.md), so a pen is a machine on a deck rather
   * than a hutch on a lawn. It said `'outdoor'` until then, and the argument
   * was that livestock live outside and a pen indoors would be a room full of
   * pigs on the shop floor — which is now the *point* rather than the
   * objection.
   *
   * `'any'` and never `'indoor'`, for the reason spelled out on `plot` above
   * and worth repeating here because this is the kind it would cost the most:
   * a pen is a placement at an absolute tile, live shops have them on grass,
   * and `compose` re-judges placements on every re-flow — so `'indoor'` would
   * shed and refund every existing pen the first time somebody drew a wall.
   * The refund is what makes it invisible: nothing reads as stolen, and what
   * you watch is your farm going away because you built a shed.
   *
   * The half this used to keep honest went with it — `whatThisUnroofs`'
   * `roofed` branch and the roofed-clock holds in `stepPens`/`stepCrops` are
   * all gone, because "nothing grows indoors" is the sentence this flag was
   * the premise of.
   *
   * `anchor: 'useAt'` because you collect from ONE side, like an appliance's
   * tray, and deliberately not the bed's any-side rule. A bed has no side
   * because it is ground you stand on; a pen has a gate.
   */
  /**
   * ...AND THE WORD IS VAT, because the seven pens are retired.
   *
   * `pen` is the id and every offered row under it is a vat (docs/vats.md step
   * 3) — Culture Tank, Myco Tower, Protein Vat — so "Pen" was a label naming
   * seven buildings `RETIRED_PIECES` no longer offers. See the note on `plot`:
   * the palette draws from the ROW, so the only place a kind's own word reaches
   * a player is a sentence about a placement or the goal chip, and both were
   * saying a word that is nowhere on the bar. The id stays `pen` for ever.
   */
  pen: {
    label: 'Vat', blocks: true, where: 'any', rotates: true, anchor: 'useAt',
    // Take only, and it is the reason `armPorts` walks `fixturesOf` with
    // `covers` rather than comparing a tile: this is the one kind with a
    // footprint, its record is the min corner, and a loader against three of
    // its four sides would otherwise find nothing standing there at all.
    // `nothing feeds the vats` is docs/pens.md's standing decision, so there is
    // no pour half to declare.
    arm: { take: true },
    /**
     * TWO CELLS ON A SIDE, and the first fixture in the game to take more than
     * one. A pen is a building rather than a shelf, and at one tile it read as
     * one — a cattle pen the same size as a jar of jam.
     *
     * On the KIND rather than on the piece, and that is forced rather than
     * chosen: `canPlace` lives here, is pure, and has never seen the catalog, so
     * a footprint that came off a `fixtures` row would mean the one function
     * that decides whether a thing fits having to resolve a placement to a
     * content row to find out. It is also the right shelf to put it on — how
     * much floor a thing takes is behaviour, in exactly the sense `blocks` and
     * `where` are, and a variant may never move a number.
     *
     * The consequence to remember when adding the next sized kind: the tile
     * `x, z` is the MIN CORNER and not the middle, because everything that
     * indexes a cell is integer. `footprint` is the cells, `footprintMid` is
     * where the art stands, and `anchorTile` takes the size so the gate lands
     * clear of the block instead of inside it.
     */
    size: 2,
  },
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
  bin: {
    // "Skip", which is what the one offered row is called and therefore the only
    // word on the bar — see `plot`. `bin` stays the id and the kind.
    label: 'Skip', blocks: true, where: 'any', rotates: true, anchor: 'useAt',
    // Pour only, and it is the one kind where the missing half is a rule rather
    // than an omission: a skip is the way OUT of the shop, so a loader that
    // could take goods back off one would be undoing the only thing it does.
    arm: { pour: true },
  },
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
    // ...and it is one of the three the ceiling is made of. See `goesOverhead`
    // for why that is not the same set as "has a flow".
    overhead: true,
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
    overhead: true,
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
    overhead: true,
    works: true,
  },
  /**
   * The packer — a crate that stands still.
   *
   * Everything else on a run moves a box from where it is to where it should be.
   * This one is the only piece that changes what is IN one, and the trip it
   * exists for is the trip nothing downstream of a delivery can make. Four eggs
   * in one box, four bread in another, four lettuce in a third is three journeys
   * down the same line to three different aisles — a hire cannot fold them
   * (`wholeCrate` refuses a box not worth more than an armful, `fit` scores each
   * at four) and a belt could not either, because every loader down the run is
   * asked one question and it is about the box in front of it. The conveyor did
   * not fix the trip; it made the same three trips without a person, and every
   * box arrived correctly the whole time.
   *
   * So: it HOLDS one box and fills it from the boxes going past. What arrives is
   * tipped rather than stopped — the piles it wants come out and the remainder
   * rides on, which is `armTip`'s shape and is what keeps it from being a plug —
   * and when the held box is worth a journey it is released onto the line.
   *
   * IT IS THE SORTER READ BACKWARDS, which is the argument for it being a piece
   * at all rather than a rung on something else. A junction is one line in and
   * several out, deciding by where the goods can go; this is several boxes in
   * and one out, deciding on the same evidence (`conveyorServes`, `shelfAccepts`
   * — the shop's own rules, so it is right about an item authored this
   * afternoon). Half that sentence was already in the game.
   *
   * Structurally a belt again, and it wears the loader's housing for the loader's
   * reason: it swallows a crate, so it is waist-high and it costs you the square.
   *
   * `rot` IS ITS DIRECTION, which is the one place it parts company with the two
   * machines beside it. `derivedFlow` covers a loader and a sorter because their
   * `rot` is spoken for — aimed at a shelf, aimed down a branch — and a packer
   * has no side to aim at, so the key is free to mean what it means on a belt.
   * That is deliberate rather than incidental: the alternative is a rotatable
   * piece whose R key does nothing, which this file names as a trap three times
   * over.
   */
  packer: {
    label: 'Packer', blocks: true, ground: T.BELT, where: 'any', rotates: true, anchor: null,
    flow: { out: 0 },
    overhead: true,
    // NO `works`, which is the one flag it does not take off the loader. That
    // warning asks whether there is a unit beside the cell to work, and a packer
    // works the box rather than the shop — so it would fire on every correctly
    // placed one, and a warning that goes off whatever you do is the thing this
    // file already records as having made the real one worthless. What is worth
    // warning about here is a run with nothing downstream that wants the box,
    // and `def.flow`'s dead-end test above already says that much.
  },
  /**
   * The tunnel — two mouths and a span that belongs to NOBODY.
   *
   * Structurally a belt again: `T.BELT`, a facing, hands on to what it faces.
   * The visible mouth is a machine housing and occupies its square; the span
   * alone is buried and blocks nobody. The other thing it adds is that
   * what it faces may be four cells away instead of one.
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
   *
   * FLOOR ONLY, and that falls out of the paragraph above: what a tunnel gives
   * back is the SQUARE, and a ceiling has not got one to give. It is also the
   * one piece whose far end is found by a scan rather than by a neighbour, and
   * that scan matches on x,z alone — so an overhead mouth pairs with a floor
   * mouth in the same column. See `goesOverhead`.
   */
  under: {
    label: 'Tunnel', blocks: true, ground: T.BELT, where: 'any', rotates: true, anchor: null,
    flow: { out: 0 },
  },
  /**
   * The lift — the only cell whose next is on the other DECK.
   *
   * A conveyor run has always been one storey, so the square a run costs is the
   * square the shop floor wanted back. A ceiling deck gives it back, and the
   * lift is the whole of what joins the two: everything else about an overhead
   * run is an ordinary belt, loader or sorter carrying `deck: 1`.
   *
   * Which WAY it goes is not `rot` and is derived before it is set: it falls out
   * of whoever feeds it, and `way` is the override for the one case that
   * derivation cannot answer (a run arriving on both storeys at once). That is
   * `under`'s pairing with the distance taken out, and it is a separate field
   * for `under`'s reason: `repositionFixture` names every field it keeps, so a
   * direction stored in `rot` is one the R key clears, and what you would watch
   * is a lift that works until you straighten it.
   *
   * `rot` is WHICH SIDE IT LANDS ON, which is the loader's meaning of the key
   * rather than the belt's. A shaft has up to four ways out on the deck it
   * arrives at and it used to take them in enum order, so the one thing about a
   * lift a player wants to say — carry on THAT way — was the one thing the
   * piece could not be told. It is a preference and never a pin (see
   * `liftOut`), so an aim that has been walled off falls back to the scan
   * instead of turning the shaft into a terminus.
   *
   * BLOCKS, like the loader and for its reason: it is a column with a track
   * going up it, not ground you walk over.
   *
   * FLOOR ONLY, which is the one place in here where "it goes on both storeys"
   * and "you may build it on either" are opposite claims. A shaft already
   * answers `conveyorAt` on both decks from one square, so a second one laid
   * overhead is the same lift said twice — and the only instruction there has
   * ever been for building one is "put it on the floor at the end of the run".
   * See `goesOverhead`.
   */
  lift: {
    label: 'Lift', blocks: true, ground: T.BELT, where: 'indoor', rotates: true, anchor: null,
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
   * The culture floor — the fifth pad, and the one the farm's output scales on.
   *
   * ### It is spelled `paddock` and it always will be
   *
   * It was authored as a paddock, and docs/vats.md brought the farm indoors and
   * renamed what the player reads. Per CLAUDE.md's rebrand rule the key, the
   * tile (`T.PADDOCK`, 17), `groundTile('paddock')`, `paddockOf` and
   * `PEN_CELLS_PER_HEAD` are all untouched, because every one of them is
   * load-bearing on a live save or an authored content row. The `paddock`
   * spelling in the code is the old name for a thing the player now sees a new
   * name for, which is ordinary, and the trap to avoid is "fixing" the mismatch
   * later. Everything below describes the same mechanism it always did.
   *
   * The bay and the drop-off hold the shop's goods, the break area holds its
   * staff, the car park holds its shoppers. This one is the deck the farm's
   * throughput is divided over, and it is the same sentence a fourth time:
   * **how big you paint it is how many lines a machine standing in it runs**.
   * `PEN_CELLS_PER_HEAD` is the exchange rate and it is the only new number in
   * the step.
   *
   * ### Why paint rather than a fence
   *
   * You already have wall edges, gates and signed ways through, so the obvious
   * shape is "a paddock is whatever your fence encloses" — flood from the
   * shelter, bounded by `SOLID`. It is the wrong shape here for three reasons,
   * and the first is fatal on its own. Enclosure in this game is shop-wide and
   * all-or-nothing (`computeIndoor` answers ZERO indoor cells for a breached
   * shell), so a second enclosure question would need its own flood, re-run on
   * every wall segment of every drag — and build mode re-flows on every one of
   * those. Then: a gate left open is a paddock that is silently the whole map,
   * or silently nothing, with no reading on screen either way. And a fence you
   * drew for the LOOK of it would start deciding the balance, which is the
   * variant rule broken — a shape may never move a number.
   *
   * So the rails stay scenery and the paint is the rule. Draw a fence round it
   * because a farm has fences, not because the game is counting them.
   *
   * ### Why the shelter does not stand on it
   *
   * A pad is never buildable — `BUILDABLE_INDOOR` is floor and
   * `BUILDABLE_OUTDOOR` is grass — so a pen stands on grass and its paddock is
   * the painted region it TOUCHES (`paddockOf`). That falls out rather than
   * being decided, and it is the right answer anyway: you do not build on the
   * delivery bay either, and a shelter standing in the middle of its own field
   * with the grazing painted around it is the picture a farm actually makes.
   *
   * Losing it is a warning rather than a refusal, for the break area's reason:
   * the fallback is the whole of what the game did before, since a pen with no
   * paddock is one head, which is step 1's numbers to the digit.
   */
  paddock: {
    // `label` is what the player reads; the KEY above is what every save, every
    // `groundTile` call and every content row reads. They disagree on purpose.
    label: 'Culture Floor',
    tile: T.PADDOCK,
    pad: true,
    does: 'culture lines run here, and how big you paint it is how many a pen standing in it runs',
    lastGone: 'that is your last culture floor tile — every pen would go back to a single line',
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
/**
 * How many cells on a side a kind of thing takes. One for all but a pen.
 *
 * A function rather than a field everyone reads, because the answer for an
 * unknown kind has to be 1: `size` is absent from every row in `FIXTURES` but
 * one, and `undefined` cells is a footprint of nothing.
 */
export const sizeOf = (kind) => FIXTURES[kind]?.size ?? 1;

/**
 * Every cell a thing of this kind, put down here, would cover — origin first.
 *
 * The origin is the MIN CORNER, so the block runs +x and +z from the tile you
 * named. It does not turn with `rot`, and for a square it need not: the day a
 * kind wants 1x3 this is the one function that has to learn about facing, which
 * is the whole reason every caller goes through it rather than adding 1 to
 * something.
 */
export function footprint(kind, x, z) {
  const s = sizeOf(kind);
  if (s <= 1) return [{ x, z }];
  const out = [];
  for (let dz = 0; dz < s; dz++) for (let dx = 0; dx < s; dx++) out.push({ x: x + dx, z: z + dz });
  return out;
}

/**
 * ...and where the middle of that block is, in world units.
 *
 * Whole numbers for everything one cell wide, so nothing that was drawn at
 * `f.x, f.z` moves on the day this exists. Half tiles for a 2x2, which is what
 * the renderer stands the art on — a pen drawn at its min corner sits a whole
 * tile up-screen of the ground it covers.
 */
/**
 * Does a placed fixture stand on this cell?
 *
 * `f.x, f.z` is the MIN CORNER of anything bigger than a tile, so the equality
 * test every caller used to write answers "is this its corner" — which for a
 * 2x2 is right about one cell in four, and what that reads as is a pen you can
 * only point at from one end of it. In `shared/` because both `fixtureAt`s ask
 * it, and two spellings of "which fixture is this" is how a menu ends up acting
 * on something nobody pointed at.
 */
export function covers(f, x, z) {
  const s = sizeOf(f?.kind);
  if (s <= 1) return f.x === x && f.z === z;
  return x >= f.x && x < f.x + s && z >= f.z && z < f.z + s;
}

export function footprintMid(kind, x, z) {
  const s = sizeOf(kind);
  return { x: x + (s - 1) / 2, z: z + (s - 1) / 2 };
}

/**
 * @param {number} size how many cells on a side the thing is. One cell is the
 *   old behaviour to the tile, which is what every caller that omits it wants.
 */
export function anchorTile(x, z, rot, size = 1) {
  const f = FACING[rot4(rot)];
  if (size <= 1) return { x: x + f.dx, z: z + f.dz };
  // One cell clear of the FACE it is turned toward, rather than one cell off
  // the origin — which for anything bigger than a tile is a spot INSIDE the
  // thing. Centred along that face, so a person stands at the middle of the
  // gate rather than at whichever corner the origin happened to be.
  const lead = Math.floor((size - 1) / 2);
  return {
    x: x + (f.dx > 0 ? size : (f.dx < 0 ? -1 : lead)),
    z: z + (f.dz > 0 ? size : (f.dz < 0 ? -1 : lead)),
  };
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
export function behindTile(x, z, rot, size = 1) {
  return anchorTile(x, z, rot + 2, size);
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
  const s = sizeOf(kind);
  if (def.anchor) out.push({ ...anchorTile(x, z, rot, s), role: 'use', field: def.anchor });
  if (def.behind) out.push({ ...behindTile(x, z, rot, s), role: 'tend', field: def.behind });
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
export function standableSide(L, f, t) {
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
  // Every cell each of them is standing on, not just its origin. A 2x2 shuffled
  // one square along overlaps three of its own cells, and with only the origin
  // forgiven it would be refused for standing where it already is — which reads
  // as a pen that cannot be moved at all.
  return !fixturesOf(L).some((f) => ignores(ignoreId, f.id)
    && footprint(f.kind, Math.round(f.x), Math.round(f.z))
      .some((c) => c.x === x && c.z === z));
}

/**
 * IS THIS FIXTURE ONE OF THE ONES IN THE AIR?
 *
 * `ignoreId` was a single id for as long as only one thing could be moving,
 * which was true right up until Move learned about a selection. A whole aisle
 * shifted one square along is the case that breaks the old spelling and does it
 * in the most convincing way there is: every shelf but the leading one lands on
 * the cell its neighbour is *currently* standing in, so each is refused for
 * being in the way of itself-one-along — the placement is perfectly legal and
 * the shop says no to all six of them.
 *
 * So it takes a `Set` as well, and every one of the eight places that used to
 * write `f.id === ignoreId` asks this instead. Which is the whole point of it
 * being a function rather than a widened comparison at each site: a site that
 * kept the `===` would work for a selection of one and quietly answer "no" for
 * the case this exists for, which is the shape half of the bugs in this file's
 * comments already have.
 *
 * A rigid translation is a bijection with no fixed points, so no two members of
 * a batch can ever land on the same cell — which is exactly what makes it safe
 * to forgive the whole set at once rather than one member at a time.
 */
export function ignores(ignoreId, id) {
  if (!ignoreId || !id) return false;
  return typeof ignoreId === 'string' ? ignoreId === id : !!ignoreId.has?.(id);
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
  // A run follows the line of the start it is HANDED: a horizontal segment lies
  // along x, a vertical one along z. Which line that is stopped being the edge
  // the press snapped to — see `edgeDragRun` — so an L is still two runs, but
  // the second one no longer needs a second press.
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
      // segment in a corner. The ends are derived against the shop as it stands,
      // so the two floods below are asking about the same list of spots.
      const stranded = fixturesOf(L)
        .map((f) => ({ f, spots: spotsOf(f, { layout: L }) }))
        .filter(({ f, spots }) => spots.length
          && indoors(Math.round(f.x), Math.round(f.z))
          && !spots.every(joined));
      /**
       * ...AND ONLY WHAT THIS PRESS CHANGES, which the paragraph above has
       * claimed since it was written and nothing here computed.
       *
       * Everything so far is a fact about the shop AFTER the wall, so a unit
       * that could not be reached this morning is reported on every wall you
       * draw for the rest of the save — about something you did days ago,
       * somewhere else in the building, and usually on purpose. That is the
       * warning-that-always-fires trap this function's own comments name twice:
       * a wall out on the grass, attached to nothing, enclosing nothing, warned
       * "that cuts 2 fixtures off from the door" and there was no press that
       * would not have.
       *
       * So the same question is asked of the shop as it stands, and only a unit
       * that was reachable before and is not after survives. The second flood
       * is inside this branch on purpose: it is only ever paid on a press that
       * was about to warn, which is a handful of the presses in a build, and
       * this runs on every frame of a drag.
       */
      const wasIndoors = (x, z) => insideStore(L, x, z);
      const wasOnFloor = reachable(L, L.door.x, L.door.z,
        (P, x, z) => wasIndoors(x, z) && isWalkableTile(P, x, z));
      const wasJoined = (p) => wasOnFloor.has(`${Math.round(p.x)},${Math.round(p.z)}`);
      const fresh = stranded.filter(({ f, spots }) =>
        wasIndoors(Math.round(f.x), Math.round(f.z)) && spots.every(wasJoined));

      if (fresh.length) {
        const what = FIXTURES[fresh[0].f.kind]?.label.toLowerCase() ?? 'fixture';
        return {
          ok: true,
          warn: fresh.length === 1
            ? `that cuts a ${what} off from the door`
            : `that cuts ${fresh.length} fixtures off from the door`,
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
  for (const f of fixturesOf(L)) {
    const def = FIXTURES[f.kind];
    // `any` is a decoration, which is at home either way and has no opinion.
    // Since docs/vats.md step 1 that also covers the farm, which is why there is
    // no second list here — see below.
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
  }

  // THE `roofed` HALF IS GONE, and it is a deletion rather than an omission.
  //
  // It counted `where: 'outdoor'` fixtures a wall would enclose and warned
  // "that roofs over N plots — nothing grows indoors". `plot` and `pen` were
  // the only two kinds that were ever `'outdoor'`, and docs/vats.md step 1 made
  // both of them `'any'` — so the loop's own first line now skips every fixture
  // that branch could have collected, and the strings could never fire again.
  //
  // A warning that cannot fire is worse than no warning: it reads as a live
  // rule to whoever greps for it, and the sentence it says out loud ("nothing
  // grows indoors") is the exact opposite of what the game now does. The
  // enforcement behind it went at the same time — the roofed-clock holds in
  // `stepCrops` and `stepPens` — so this is one rule retired in one place
  // rather than a string left behind by a flag flip.
  const label = (list) => FIXTURES[list[0].kind]?.label.toLowerCase() ?? 'fixture';
  if (evicted.length === 1) return `that leaves a ${label(evicted)} standing outside`;
  if (evicted.length) return `that leaves ${evicted.length} fixtures standing outside`;
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
// still needs `BUILDABLE_INDOOR`, and a plot needed bare grass until
// docs/vats.md step 1 made it `where: 'any'` — it takes either now, which is a
// change to the FIXTURE's rule and not to this brush's. Both stay exactly as
// strict as the sets say they are. Which design of floor it is rides in a
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
      // Down/right unless that leaves the world, in which case up/left. The
      // limits are the last CELL rather than the last paintable one, because
      // the border ring is paintable now — clamped a row in, a two-thick road
      // dragged along the boundary would widen the wrong way and leave the ring
      // bare, which is the strip this whole change is about.
      if (limit == null || b + room <= limit) return [a, b + room];
      return [Math.max(0, a - room), b];
    };
    if (deep <= wide && deep < thick) [az, bz] = grow(az, bz, L ? L.h - 1 : null);
    else if (wide < thick) [ax, bx] = grow(ax, bx, L ? L.w - 1 : null);
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
 * Which cells a selection box covered, given the four ground-plane corners the
 * screen rectangle landed on.
 *
 * `groundStroke`'s argument said about a box somebody dragged with the CAMERA in
 * the way. The marquee is a screen rectangle — `fixturesInRect` tests against it
 * in screen space, exactly, and that is right for a fixture, which is drawn most
 * of a tile up-screen of the ground it stands on. Ground has no such freedom: a
 * cell is where it is, so the honest question is which cells lie under the box.
 *
 * It is a **quad and never a tile rect**, which is the whole reason this exists.
 * The camera is at 45°, so a square dragged on screen lands on the floor as a
 * diamond, and the axis-aligned box around that diamond is very nearly twice the
 * area — a copy region taken from it comes home with the aisle next door and the
 * yard behind it. Four corners cost eight numbers on the wire, which is
 * `build-edge`'s rule (send the ends, re-derive the cells) said about an area.
 *
 * Convex by construction — a rectangle projected onto a plane is one — so the
 * test is the standard "same side of all four edges", written to accept either
 * winding rather than trusting the client to send them round the right way.
 *
 * @param {object} L layout, which is also the clip: nothing outside it exists
 * @param {?Array<{x: number, z: number}>} quad four corners, in order round the box
 */
export function quadCells(L, quad) {
  if (!L || !Array.isArray(quad) || quad.length !== 4) return [];
  const pts = quad.map((p) => ({ x: Number(p?.x), z: Number(p?.z) }));
  if (pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z))) return [];

  const lo = {
    x: Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)))),
    z: Math.max(0, Math.floor(Math.min(...pts.map((p) => p.z)))),
  };
  const hi = {
    x: Math.min(L.w - 1, Math.ceil(Math.max(...pts.map((p) => p.x)))),
    z: Math.min(L.h - 1, Math.ceil(Math.max(...pts.map((p) => p.z)))),
  };

  // A cell is in if its CENTRE is, which is the same call `pickTile` makes about
  // a single square: a box that took every cell it clipped a corner of would
  // reach a tile further out on all four sides than the one you were pointing at.
  const inside = (x, z) => {
    let neg = false;
    let pos = false;
    for (let i = 0; i < 4; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % 4];
      const cross = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
      if (cross < 0) neg = true;
      if (cross > 0) pos = true;
      if (neg && pos) return false;
    }
    return true;
  };

  const out = [];
  for (let z = lo.z; z <= hi.z; z++) {
    for (let x = lo.x; x <= hi.x; x++) if (inside(x, z)) out.push({ x, z });
  }
  return out;
}

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
 * Which KIND of ground was laid on each cell, as a lookup.
 *
 * `groundIndex`'s other sibling, and it exists for the one cell where `tiles`
 * is not the answer: a conveyor stamps `T.BELT` over whatever was painted, so
 * `groundKindOfTile` says null down the whole of a run while the stored row
 * still remembers the parquet under it. Everywhere else the tile IS the kind
 * and this would only be a second opinion about it — which is why nothing but
 * the conveyor branch of `canPaintGround` asks, and why `Game.buildGround`
 * spells the same fallback inline.
 */
export function groundKindIndex(L) {
  const m = new Map();
  for (const f of L?.ground ?? []) if (f.k) m.set(`${f.x},${f.z}`, f.k);
  return m;
}

/**
 * Which look is remembered UNDER each cell, as a lookup.
 *
 * `groundIndex`'s sibling, and it exists for the reason that one keeps only `p`:
 * a cell has two answers now, and every caller that wants the top one must not
 * have to learn that. Sparse in the same way and for the same reason — only a
 * job painted over a design somebody laid has an entry here at all, so a shop
 * that has never painted a floor under a pad sends nothing.
 */
export function groundUnders(L) {
  const m = new Map();
  for (const f of L?.ground ?? []) if (f.u) m.set(`${f.x},${f.z}`, f.u);
  return m;
}

/**
 * WHAT ONE CELL BECOMES WHEN A BRUSH LANDS ON IT — or null for a cell this
 * stroke does nothing to.
 *
 * The one place the layering rule lives, called by `canPaintGround` for the
 * ghost and by `Game.buildGround` for the press, because the two disagreeing
 * about what a stroke *does* is the green-ghost bug with a paintbrush: a
 * preview that promises a floor over a room the press leaves as a stockroom.
 *
 * ### A look goes UNDER a job, and that is the whole of it
 *
 * `GROUND` partitions in two and the split has been in that table since the
 * yard stopped being furniture: a floor, a road, a pavement and the land are a
 * *look*, and the five pads carry a *job*. One overlay held one answer per cell,
 * so those two were rivals — dragging a floor across your stockroom took the
 * storage away, and the only tell was that the crates stopped arriving. Nothing
 * warned, because painting over a pad is exactly how you MOVE one, and the
 * stroke could not tell the difference between "put the bay over there" and "lay
 * a nice floor through here".
 *
 * They were never rivals. A cell that says "deliveries land here" is carrying
 * meaning no colour ever could, and a colour is not an answer to it — so a look
 * painted onto a job is remembered *beneath* it (`u`, a kind and a piece), the
 * job draws and behaves exactly as it did, and taking the job up hands the look
 * back rather than scraping the cell to nothing. It is the same sentence
 * `canPaintGround` already says one cell over about a conveyor: **under a
 * conveyor is still ground**, and a run laid across your parquet does not owe
 * you a repaint. Under a pad is still ground too.
 *
 * Four things about it are load-bearing.
 *
 * **`k` is still the top**, so `groundTile(k)` is still the tile and not one
 * reader of `tiles`, `blocked`, `indoor`, a pad region or the renderer changed.
 * The alternative — the look on top with the job beside it — is the two-layer
 * shape docs/building.md turned down, and it turns the tile into a precedence
 * question asked in a pure generator that has never seen the catalog.
 *
 * **An underlay is only ever a look, and only ever one somebody BOUGHT.** A
 * seeded pad, the generated street and plain shell floor all arrive with no
 * piece, and a `u` with no piece would hand back ground nobody paid for on every
 * scrape. So `u.p` is never null, which is what makes the refund arithmetic
 * below a single question rather than a table.
 *
 * **Nothing is refunded for a look that went under.** You still own it — it is
 * remembered, and it comes back — so handing half its price over as well is a
 * printer you run by painting a pad over your own floor.
 *
 * **A selection remove clears BOTH** (`all`), or copy-and-delete stops being
 * symmetrical: `removeSelection` reaches every cell once, and a reveal there
 * would leave a room-shaped stain of perfectly good flooring behind the
 * stockroom it just deleted — which is the stain `verify:stamp` exists to catch,
 * arriving through the one door that was allowed to peel a layer.
 *
 * @param {?object} was   `{k, p, u}` — the kind the cell IS (off `tiles`, with
 *                        the stored row as the fallback a conveyor needs), the
 *                        design painted on it, and the look under it.
 * @param {?string} kind  the ground kind being laid, or null to take it up.
 * @param {?string} piece which design of it — never null while `kind` is set,
 *                        because the kind is read off the catalog row.
 * @param {?string} bare  the kind an eraser leaves HERE: `floor` indoors and
 *                        null outdoors, which is `canPaintGround.leaves` said as
 *                        a kind rather than as a tile.
 * @returns {?object} `{k, p, u, from}` — the new entry, plus which piece's
 *                    refund this cell earns.
 */
export function groundPaint(was, kind, piece, bare, { all = false } = {}) {
  const now = { k: was?.k ?? null, p: was?.p ?? null, u: was?.u ?? null };
  // Bare ground outdoors is stored as NO kind and reads back off the tile as
  // `lawn`, and they are the same cell — an entry saying `lawn` would be carried
  // out into the layout, where "nobody has painted here" is spelled by there
  // being nothing. So the two are one answer for the purpose of "did anything
  // move", which is the eraser's own no-op skip: dragging Bare Ground across a
  // field must charge nothing and warn about nothing.
  const norm = (k) => k ?? 'lawn';
  const same = (next) => norm(next.k) === norm(now.k) && next.p === now.p
    && (next.u?.k ?? null) === (now.u?.k ?? null)
    && (next.u?.p ?? null) === (now.u?.p ?? null);
  const done = (next) => (same(next) ? null : next);

  if (kind == null) {
    // Ground with a job that is not a ground kind — a bed, a wall, a doorway.
    // There is nothing painted here to take up, which is the answer
    // `canPaintGround` has always given and the answer the press did not: it
    // wrote a floor entry over the bed's own cell and reported a tile taken up,
    // which the next re-flow stamped straight back over. Harmless and untrue.
    if (now.k == null) return null;
    // The reveal. Not under `all`, which is a whole region being deleted rather
    // than one layer being peeled.
    if (!all && now.u) return done({ k: now.u.k, p: now.u.p, u: null, from: now.p });
    return done({ k: bare ?? null, p: null, u: null, from: now.p });
  }

  // A LOOK OVER A JOB: the job stays, and what you laid is remembered under it.
  if (!isPad(kind) && isPad(now.k)) {
    return done({ k: now.k, p: now.p, u: { k: kind, p: piece }, from: now.u?.p ?? null });
  }

  if (isPad(kind)) {
    // A JOB OVER A JOB — moving your bay onto your storage. The design on top
    // changes hands; whatever was already remembered underneath stays
    // remembered, because neither stroke has touched it.
    if (isPad(now.k)) return done({ k: kind, p: piece, u: now.u, from: now.p });
    // A JOB OVER A LOOK. `keep` is null exactly when there was no design to
    // keep, which is why nothing is handed back on this branch either way.
    const keep = now.p ? { k: now.k, p: now.p } : null;
    return done({ k: kind, p: piece, u: keep, from: null });
  }

  // A LOOK OVER A LOOK is the whole of what this used to be.
  return done({ k: kind, p: piece, u: null, from: now.p });
}

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
 * The paddock THIS pen stands in — the contiguous run of painted cells its
 * footprint touches, and never every paddock cell on the map.
 *
 * A pad is one named region in as many pieces as you painted it, and reading it
 * globally is a bug docs/belts.md already paid for once: `dropGoods` fills a
 * region by list order, so a loader beside the fridges handed its box to the
 * yard thirty tiles away. Said about grazing it would be worse than a wrong
 * shelf — a paddock at the top of the farm would fatten a hen house at the
 * bottom of it, so the field you painted and the animals in it would be two
 * unrelated facts that happen to be on the same save.
 *
 * So it is a flood over TILES, four-connected, seeded from the cells around the
 * block. Deliberately not a flood over EDGES: this is the one place a second
 * enclosure question could have crept in, and `GROUND.paddock`'s note is why it
 * did not. Nothing here consults a wall, which means a fence you draw across a
 * paddock does not divide it — paint is the rule, and if you want two fields,
 * leave a cell of grass between them.
 *
 * Pure, and O(the region) rather than O(the map). Callers that ask it per tick
 * should cache it against the layout's identity, the way `conveyorFlow` does —
 * a re-flow replaces `L`, which is exactly when the answer can have changed.
 */
export function paddockOf(L, pen) {
  const want = groundTile('paddock');
  const out = [];
  if (want == null || !L?.tiles) return out;
  const seen = new Set();
  const stack = [];
  const visit = (x, z) => {
    if (x < 0 || z < 0 || x >= L.w || z >= L.h) return;
    const k = z * L.w + x;
    if (seen.has(k) || L.tiles[k] !== want) return;
    seen.add(k);
    out.push({ x, z });
    stack.push({ x, z });
  };
  for (const c of footprint(pen.kind ?? 'pen', pen.x, pen.z)) {
    for (const d of FACING) visit(c.x + d.dx, c.z + d.dz);
  }
  while (stack.length) {
    const c = stack.pop();
    for (const d of FACING) visit(c.x + d.dx, c.z + d.dz);
  }
  return out;
}

/** Does this pen's block touch any of those cells? — "is it in that paddock". */
export function pennedIn(pen, cellKeys, w) {
  for (const c of footprint(pen.kind ?? 'pen', pen.x, pen.z)) {
    for (const d of FACING) if (cellKeys.has((c.z + d.dz) * w + (c.x + d.dx))) return true;
  }
  return false;
}

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
   *
   * A KIND rather than a tile, because `groundPaint` writes the overlay entry
   * and the overlay speaks in kinds — null outdoors, which is how "nobody has
   * painted here" is spelled, since an entry saying `lawn` would be carried out
   * into the layout as a cell somebody chose.
   */
  const bareAt = (x, z) => (insideStore(L, x, z) ? FLOOR_KIND : null);
  const painted = groundIndex(L);
  const unders = groundUnders(L);
  // Only the conveyor branch reads this — everywhere else the tile is the kind.
  const laid = groundKindIndex(L);

  // What the pads have now, so the stroke can be judged against what it would
  // leave rather than against each cell in isolation. Painting over the last
  // bay is only a consequence when it was the last one.
  const padWas = new Map(PAD_KINDS.map((k) => [k, 0]));
  const padLost = new Map(PAD_KINDS.map((k) => [k, 0]));
  for (const k of PAD_KINDS) padWas.set(k, padCells(L, k).length);

  let changed = 0;
  let bared = 0;
  // Cells of the border ring this stroke would leave with nothing on wheels
  // able to cross them — see `onRing` and the warning at the foot.
  let severed = 0;
  for (const c of cells) {
    const x = Math.round(c.x);
    const z = Math.round(c.z);
    /**
     * THE WHOLE MAP, INCLUDING THE RING — which it did not use to be.
     *
     * This read `x < 1 … x >= L.w - 1`, so the outermost cell on all four sides
     * was refused to the brush. The reason was real and is written down in
     * `defaultStreet`: the ring is the public road, `laneVia` runs every lorry
     * and every shopper's car out to it and then ALONG it to the edge of the
     * map, and ground you cannot lay is ground the seed must not lay either —
     * so the seeded street stops one row short of the world on purpose.
     *
     * What that argument never accounted for is that nothing on screen says any
     * of it. A strip of ordinary lawn you cannot paint, with your own road and
     * pavement stopping a square before it, does not read as "the public road",
     * it reads as a bug — and it was reported as one. Two halves to the answer
     * and this is the first: the ring is yours to paint, so the map has no
     * dead border. `freezeRing` is the second, and paves it as a road on the
     * way in so it LOOKS like the thing it has always been.
     *
     * Fixtures and walls are untouched: `canPlace` and `canPlaceEdges` still
     * refuse the ring, so nothing anybody builds can ever stand in a lorry's
     * way. The one thing a brush can still do to it is below.
     */
    if (x < 0 || z < 0 || x >= L.w || z >= L.h) return no('off the edge of the world');
    const onRing = x === 0 || z === 0 || x === L.w - 1 || z === L.h - 1;

    const ground = tileAt(L, x, z);
    const was = groundKindOfTile(ground);

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
    // A LOOK, though, and never a JOB — which is `groundPaint`'s own partition
    // rather than a second rule about conveyors. A look is a colour and the cell
    // wears it whether or not a rail is set into it; a pad is a sentence about
    // what the cell DOES, and every reader of that sentence reads `tiles`, which
    // is a belt here and always will be. So a delivery bay painted under a run
    // would draw as a bay, hold nothing, and never start — a lie you can see —
    // where parquet under a run is simply parquet with a rail on it.
    //
    // It was `lay === base` for a while, which is the same refusal aimed one
    // notch too wide: it let the land through outdoors and floor through
    // indoors, and turned down every other look on both counts. What that cost
    // is the ordinary press — a run out to the yard crosses the wall, so half
    // your conveyor is on grass, and laying the shop's own floor under it came
    // back "only ground goes under a conveyor" over a stroke that changes no
    // tile anywhere.
    if (ground === T.BELT) {
      if (laying && isPad(kind)) {
        return no(`a ${GROUND[kind].label.toLowerCase()} can't go under a conveyor`);
      }
      // Asked of the one function that owns what a stroke does to a cell, the
      // same way every other cell here is, so the ghost and the press cannot
      // disagree about whether this one was even painted. The kind comes off the
      // STORED row rather than off `tiles` — that is the whole of what a belt
      // breaks, since the stamp buries whatever was underneath — and the tile
      // cannot move, so none of the accounting below this applies.
      const next = groundPaint(
        {
          k: laid.get(`${x},${z}`) ?? null,
          p: painted.get(`${x},${z}`) ?? null,
          u: unders.get(`${x},${z}`) ?? null,
        },
        kind,
        piece,
        bareAt(x, z),
      );
      if (next) changed++;
      continue;
    }

    // Only ever over ground. Everything else a cell can be made of is
    // something with a job of a different sort — a bed, the path out to the
    // fields, a wall — and paving one over would take that job away silently,
    // with no fixture removed and nothing to put back.
    if (laying && ground !== T.GRASS && was == null) return no(groundIsBusy(ground));

    // What this cell would become, asked of the one function that answers it —
    // `groundPaint`, which the press runs too. Null is a cell this stroke does
    // nothing to, and the three no-ops it folds in were three separate skips
    // here: restyling counts but re-laying the same design does not, taking up
    // ground that is already bare does not, and there is nothing to take up off
    // a bed.
    const next = groundPaint(
      {
        k: was,
        p: painted.get(`${x},${z}`) ?? null,
        u: unders.get(`${x},${z}`) ?? null,
      },
      kind,
      piece,
      bareAt(x, z),
    );
    if (!next) continue;

    // Where the cell ENDS UP, which everything below is judged on rather than on
    // what was aimed at it.
    const tile = next.k ? groundTile(next.k) : T.GRASS;

    /**
     * GROUND OUT FROM UNDER SOMETHING STANDING ON IT, and it is the TILE that
     * decides — in BOTH directions, which is the half that was missing.
     *
     * This refusal is the one deliberate exception to warn-don't-refuse
     * (`groundIsBusy`'s note, and docs/building.md's): the generator would not
     * leave a hen house standing on a paddock, it would DROP the placement on
     * the next re-flow and refund it, so the brush would be a bulldozer wearing
     * a paintbrush — and undo cannot put it back, because what it restores is
     * the ground rather than the shed placement.
     *
     * It was asked of the ERASER only, and every word of the argument is about
     * laying too. A pen stands on grass, so `groundIsBusy` never fires (grass is
     * exactly what you may paint over) and `blocked` was never consulted: one
     * press of Muddy Yard over your own hen house stamped `T.PADDOCK`, the
     * re-flow found a pen whose `where` is outdoor grass, and the building was
     * quietly sold back. Money in, so nothing reads as stolen — what you watch
     * is a fixture disappearing under a colour, with no refusal and no way back.
     *
     * The TILE is the test rather than the stroke, or redecorating an aisle
     * becomes impossible: a floor swapped for another floor leaves `T.FLOOR`
     * where it was, so nothing standing on it is stranded and the press must go
     * through. That is also what makes a look laid UNDER a pad free of this —
     * the cell it lands on is the cell it was — and it is what the eraser's own
     * version of this check should always have said: taking a design up off a
     * shop floor strands nobody.
     */
    if (tile !== ground && blockedAt(L, x, z)) return no('something is standing on it');
    changed++;

    // Two consequences, and both are about the TILE for the same reason: a cell
    // that ends up indoors and is not floor is one nothing can ever be built or
    // dug on, and a pad cell this stroke really does paint over is one that pad
    // no longer has.
    //
    // Judged on where the cell ends up, or a floor dragged across a stockroom
    // warns that it is taking your last storage tile away and then does not take
    // it — a warning that goes off whatever you do is one nobody reads.
    if (tile === ground) continue;
    if (was && padWas.has(was)) padLost.set(was, padLost.get(was) + 1);
    if (tile !== T.FLOOR && insideStore(L, x, z)) bared++;
    // ...and the ring's own version of that sentence. A cell out there that
    // nothing can drive over is a hole in the public road, and the public road
    // is the only way anything with wheels reaches the edge of the map. Two
    // brushes can make one — the break area and the paddock, the two pads that
    // are walkable and not drivable — and both are perfectly reasonable things
    // to want along the boundary, which is why this is a warning rather than a
    // refusal. Judged on where the cell ENDS UP, like everything else here.
    if (onRing && !DRIVABLE.has(tile)) severed++;
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

  // Blocking the road round the outside. Allowed — it is your land and a fence
  // of paddock along the boundary is a thing somebody will want — but the
  // delivery lorry and every shopper who drives here get to the edge of the map
  // along that ring, and a shop nobody can deliver to is worth being told about
  // before rather than discovered at the wholesaler. Said in the road's own
  // words: nobody has to know what a border ring is to read it.
  if (severed) {
    warns.push(severed === 1
      ? 'that blocks a square of the road round the outside — vans and cars drive on it'
      : `that blocks ${severed} squares of the road round the outside — vans and cars drive on it`);
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
export const CONVEYOR_KINDS = ['belt', 'arm', 'sorter', 'under', 'lift', 'packer'];

/**
 * The kinds a DRAG lays a line of.
 *
 * Not the same set, and the difference is the tunnel. A run is laid by dragging
 * because a belt is one cell repeated; a tunnel is two mouths with a gap that
 * has to stay empty, so dragging one lays a mouth on every square of the very
 * span the piece exists to give back — which stamps `T.BELT` down the whole
 * line, and the floor brush then refuses the ground you were promised.
 */
export const RUN_KINDS = ['belt', 'arm', 'sorter', 'packer'];

/**
 * How many cells one drag may lay — of conveyor, or of anything else.
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
 * The cells one drag lays, in the order a crate would travel them.
 *
 * An L rather than a straight line — the long axis first, then the short — which
 * is the shape you are actually drawing when you take a belt round a shop, and
 * it means a loop is four drags instead of eight. The corner falls out of the
 * facings and needs no piece, exactly as it does when you lay them one at a
 * time.
 *
 * Each cell FACES THE NEXT ONE **when `follow` is on**, which is the whole
 * reason a belt wants a drag: the direction of the gesture is the direction of
 * the run, unambiguously, and it is the one place in this game where that is
 * true. The last cell keeps the facing it arrived with, or a run would end
 * pointing at whatever rot 0 is.
 *
 * `follow` is off for everything else, and that is the one thing that had to be
 * decided when the drag stopped being conveyor-only. A belt's rotation IS its
 * direction, so a corner turns it; a shelf's is which side you browse it from,
 * and a row of shelving that swung round at the bend would be an aisle you
 * cannot walk. Off, every cell takes the armed facing — which is also the
 * facing the ghost was showing when the drag started, since `faceAlong` had
 * already assisted it onto the tile you pressed. The flag is a property of the
 * KIND (`RUN_KINDS`) rather than of the gesture, so no caller has to remember
 * which it is asking about.
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
export function runCells(from, to, max = BELT_RUN_MAX, rot = 0, follow = true) {
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
  if (!follow) return cells.map((c) => ({ x: c.x, z: c.z, rot: last }));
  return cells.map((c, i) => {
    const nxt = cells[i + 1];
    if (nxt) {
      const d = dirs.find((v) => v.x === Math.sign(nxt.x - c.x) && v.z === Math.sign(nxt.z - c.z));
      if (d) last = d.r;
    }
    return { x: c.x, z: c.z, rot: last };
  });
}

/** Does a drag of this kind turn each cell to follow the gesture? See above. */
export const runFollows = (kind) => RUN_KINDS.includes(kind);

/**
 * The fixtures one drag of a named kind lays.
 *
 * Almost every fixture is a row: every square the pointer crosses gets one.
 * A tunnel is the deliberate exception. It is two mouths with an unowned
 * span between them, locked to the dominant axis of the gesture and capped at
 * the longest span `tunnelExit` can discover. Both mouths face from the press
 * toward the release, because that direction is the direction goods travel.
 *
 * A click still lays one mouth. That preserves the original two-click way of
 * assembling or repairing a tunnel while making a drag the direct two-ended
 * gesture the palette describes.
 */
export function fixtureRunCells(kind, from, to, max = BELT_RUN_MAX, rot = 0) {
  if (kind !== 'under') return runCells(from, to, max, rot, runFollows(kind));
  if (!from) return [];

  const end = to ?? from;
  const dx = end.x - from.x;
  const dz = end.z - from.z;
  if (!dx && !dz) return [{ x: from.x, z: from.z, rot: rot4(rot) }];

  const alongX = Math.abs(dx) >= Math.abs(dz);
  const delta = alongX ? dx : dz;
  const distance = Math.min(Math.abs(delta), TUNNEL_SPAN + 1);
  const step = Math.sign(delta);
  const facing = alongX ? (step > 0 ? 0 : 2) : (step > 0 ? 1 : 3);
  return [
    { x: from.x, z: from.z, rot: facing },
    {
      x: from.x + (alongX ? step * distance : 0),
      z: from.z + (alongX ? 0 : step * distance),
      rot: facing,
    },
  ];
}

/** A cell whose pass-through is DERIVED rather than being its own `rot`. */
export const derivedFlow = (kind) => kind === 'arm' || kind === 'sorter';

export function conveyorsOf(L) {
  return [...(L?.belts ?? []), ...(L?.arms ?? []), ...(L?.sorters ?? []),
    ...(L?.unders ?? []), ...(L?.lifts ?? []), ...(L?.packers ?? [])];
}

/**
 * Which storey a conveyor cell is on. 0 is the floor and is every cell ever
 * laid, which is what makes the ceiling opt-in rather than a change to every
 * save in existence.
 *
 * It is a field on the PLACEMENT rather than a second set of kinds, for R3's
 * reason and for a sharper one: a ceiling run wants belts, loaders and sorters,
 * so kinds would be three duplicates that then have to be kept in step with the
 * three originals for ever. It rides a re-flow the way `mode`, `auto` and
 * `reject` do — named in `compose`, or the first wall segment you drag drops the
 * whole overhead run onto the floor.
 */
export const CEILING = 1;

/**
 * ...and the storey BELOW, which is an address and never a place you build.
 *
 * A tunnel used to be its own physics: a pair of mouths, a `underPiston` clock
 * counting 0..2 through a stroke, a second clock (`underRise`) for the far end,
 * an owner map of its own, and a span that was one long flat leg the crate was
 * simply hidden along. Every one of those is a thing the LIFT already does with
 * one number — `crate.deck`, a fraction between two storeys — and two spellings
 * of "a box is between decks" is two state machines that drift.
 *
 * So a tunnel is a lift that goes down. The span dips to this deck, the crate's
 * own `deck` carries it, and the piston is drawn from that fraction exactly as
 * the shaft's carrier is.
 *
 * It is NOT a third storey. Nothing may be placed here: `goesOverhead` is
 * unchanged, `canPlace` never offers it, and no cell ever answers `deckOf` with
 * it — the span belongs to nobody, which is the whole of what a tunnel gives
 * back and the reason Factorio's underground belt is a pair of mouths rather
 * than a floor you lay. Only a crate is ever down here, and only in transit.
 */
export const BASEMENT = -1;

export const deckOf = (c) => (c?.deck === CEILING ? CEILING : 0);

/**
 * May this kind be built on the ceiling at all?
 *
 * It was `def.flow`, which reads as "is this a conveyor" and is one kind too
 * broad in each direction that matters. A **lift** is the piece that JOINS the
 * two storeys — it answers `conveyorAt` on both decks from one square — so a
 * lift laid overhead is a second spelling of the lift already there, and the
 * only build instruction there has ever been for one (docs/belts.md step 8) is
 * "put a Lift on the floor at the end of the run". A **tunnel** is the piece
 * that gives a floor SQUARE back, which is the one thing a ceiling has not got
 * to give — and `tunnelAhead` matches its far mouth on x,z alone, so an
 * overhead mouth pairs with a floor mouth in the same column and hands its
 * crate down a storey. That is docs/belts.md's own "a hand-off has a storey"
 * bug, arriving through the one piece whose pairing is a scan rather than a
 * neighbour.
 *
 * It is asked in four places and they are the four halves of one decision: the
 * refusal (`canPlace`), the field on the placement (`Game.placeFixture`), what
 * the client sends, and whether the Floor/Overhead pair is on screen at all
 * (`UI.deckable`). A control offered for a placement the rules refuse is the
 * green-ghost bug wearing a switch — which is exactly how this was reported,
 * as a storey toggle that appeared for the two pieces that cannot use one.
 */
export const goesOverhead = (kind) => !!FIXTURES[kind]?.overhead;

/**
 * ...and the same set said in WORDS, for the three places that refuse.
 *
 * "belts, loaders and sorters" was written out by hand in `canPlace`, in the
 * deck toggle's toast and in the palette tile's tip, which is this file's own
 * trap: a list of the only members a category had, in three copies, none of
 * which fails when a fourth arrives — the refusal simply names three of four
 * and the player is told the tool they are holding cannot do the thing it just
 * did. Derived, so the sentence is right the day somebody authors a fifth.
 */
export function overheadKinds() {
  const names = FIXTURE_KINDS.filter(goesOverhead)
    .map((k) => `${FIXTURES[k].label.toLowerCase()}s`);
  if (names.length < 2) return names[0] ?? 'nothing';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Two cells are neighbours only on the same deck — and this one line is what a
 * second storey IS.
 *
 * Flow, lines, branches and jams are all keyed by fixture id and have never
 * cared how high a crate is; the only thing in the whole system that assumes
 * one storey is that a neighbour is found by x,z. Leave it out and a ceiling
 * run laid over a floor run merges with it silently: boxes change storey at
 * every crossing, which draws as a conveyor that teleports.
 */
const deckKey = (c) => `${c.x},${c.z},${deckOf(c)}`;

/** The cell one quarter turn off this one, on this one's own deck. */
const stepFrom = (c, r) => ({ ...anchorTile(c.x, c.z, r), deck: deckOf(c) });

/**
 * ...and the FIFTH way out, which is the same square on the other storey.
 *
 * Deliberately its own function rather than a fifth entry in the four-way loop,
 * and that separation is the whole safety of step 9. `stepFrom` is the rule that
 * MAKES a second storey — leave the deck out of it and a duct laid over a run
 * merges with it silently — so a vertical neighbour arriving through the same
 * loop would be that merge with a nicer spelling: every cell of every duct
 * joined to whatever happened to be underneath it, boxes changing storey at
 * every crossing, drawn as a conveyor that teleports and read as one that works.
 *
 * So every place that enumerates ways out has to ask for this BY NAME, and the
 * two that do are the two the player can be said to have chosen — a junction,
 * which is the piece whose entire job is choosing between ways out, and a loader
 * with nowhere else to hand on. A plain belt never asks: it points where it
 * points, and a run laid under a duct is still a run laid under a duct.
 */
/**
 * The two things you can tell a shaft, beside letting it work itself out.
 *
 * A closed set for `sorter.auto`'s reason — three readers have to agree, and a
 * typo would be a lift that silently went back to deriving. `null` is the third
 * state and is every shaft ever built.
 */
export const LIFT_WAYS = ['up', 'down'];

/**
 * What a junction does with a box — one setting with four answers.
 *
 * Two of them read the shop: `smart` sends each box down a line that can
 * actually put it away, and `alternate` is that with the thinking switched off.
 * The other two are the player's own routing instruction, and they are a pair
 * about the same T: `straight` favours the line that carries on, `branch`
 * favours the leg the junction is AIMED at. That second one is what gives R a
 * meaning on this piece — until it existed `rot` only ever broke a tie, so
 * turning a sorter was a press with nothing on the far side of it.
 *
 * A closed set for `LIFT_WAYS`' reason: four readers have to agree — the
 * chooser, the snapshot, `compose` and the menu — and a typo would be a junction
 * that silently went back to sorting, which is the answer three of the four
 * already fall back to.
 */
export const SORTER_ROUTES = ['smart', 'straight', 'branch', 'alternate'];

/**
 * ...read off a cell or a placement, which is the ONE spelling of the default.
 *
 * `route` is absent on every junction built before it existed and `auto` is what
 * the two answers those junctions have were called, so the pair has to be read
 * together — separately, a live save's splitters quietly start sorting again on
 * the next wall you draw.
 */
export const sorterRoute = (c) => (SORTER_ROUTES.includes(c?.route) ? c.route
  : c?.auto === false ? 'alternate' : 'smart');

/**
 * ...and whether that answer is one the player NAMED a leg with.
 *
 * `smart` and `alternate` are stored as `auto` and nothing else, so only these
 * two ride on the placement as a `route` — see `setSorterRoute`.
 */
export const FAVOURING = (route) => route === 'straight' || route === 'branch';

export const acrossFrom = (c) => ({
  x: c.x, z: c.z, deck: deckOf(c) === CEILING ? 0 : CEILING,
});

/**
 * IS THIS THE SAME FIXTURE — asked of a held reference against the shop as it
 * now stands, and never by id.
 *
 * An id is not durable. `repositionFixture` re-mints one on every turn, and the
 * generator mints `shelf-p0`, `shelf-p1`… positionally and re-mints those on
 * every re-flow — so an id lookup can quietly land on a *different* shelf. Tile
 * and kind is what the client has always fallen back to, and it was right for
 * exactly as long as a square was one place.
 *
 * A duct over a belt matches on both. Three call sites held their own copy of
 * this test — the open menu following its fixture, the teal selection following
 * the same fixture with no menu up, and a bulk pick's held refs — and all three
 * re-pointed at whichever of the pair `fixturesIn` happened to list first. What
 * that reads as is the R key deselecting you: turn the duct, the re-flow moves
 * the re-minted placement to the end of the list, the selection lands on the
 * FLOOR cell, and the next press turns that instead. Then it swaps back, for
 * the same reason, forever.
 *
 * So it is one function, here rather than in `client/`, because the answer has
 * to be identical in all three or the ring is drawn round one fixture while the
 * menu is open on another.
 */
export const sameFixture = (a, b) => !!a && !!b
  && a.x === b.x && a.z === b.z && a.kind === b.kind && deckOf(a) === deckOf(b);

/**
 * The tiles a loader can reach — the four beside it, on either storey.
 *
 * An overhead loader serves the floor fixtures on both sides of the aisle just
 * as a floor loader does. The difference is the journey: its spur runs out from
 * the duct and then drops, while a floor loader hands straight across. Keeping
 * the footprint identical is what makes moving a working aisle overhead free
 * the square without silently halving what each loader serves.
 *
 * Here rather than in either half, because FIVE loops enumerate a loader's
 * sides and every one of them has to agree: the swing that pours, the two
 * `conveyorMeets`/`conveyorServes` walks that say what a run reaches, and the
 * chevrons and spurs the renderer draws. Written out four-ways in any one of
 * them, an overhead loader either serves shelves it cannot see or is drawn
 * reaching them — and a mark that promises a hand-over the machine never makes
 * is the green-ghost bug on a ceiling.
 */
export function armReach(c) {
  return [0, 1, 2, 3].map((r) => anchorTile(c.x, c.z, r));
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
 * The nearest mouth ahead of this one facing the same way, spoken for or not.
 *
 * The NEAREST one wins, so three mouths in a line are two tunnels rather than
 * one that skips the middle — otherwise laying a third would silently re-route
 * the pair you already had. A mouth ahead pointing some OTHER way ends the scan
 * rather than being skipped past, or the pair you can see is beaten by one you
 * cannot.
 *
 * ON ITS OWN STOREY, and this is a BELT rather than a rule — `overhead` is what
 * keeps a mouth off the ceiling in the first place, and `verify:ceiling` §2b is
 * where that is argued. It is asked here as well because this scan matched on
 * x,z alone, which made it the second cell in the game that could span two
 * storeys: pair a floor mouth with a duct mouth and the crate changes deck with
 * no shaft anywhere near it, which is `verify:ceiling` §3's whole claim undone
 * by a lookup. A save built before the placement rule is exactly the shop that
 * has one, and `compose` still writes `under.deck` — so the refusal at the press
 * cannot be the only thing standing between a tunnel and a storey.
 */
function tunnelAhead(L, cell, back = false) {
  const step = anchorTile(cell.x, cell.z, rot4((cell.rot ?? 0) + (back ? 2 : 0)));
  const dx = step.x - cell.x;
  const dz = step.z - cell.z;
  const deck = deckOf(cell);
  for (let i = 1; i <= TUNNEL_SPAN + 1; i++) {
    const x = cell.x + dx * i;
    const z = cell.z + dz * i;
    const other = (L?.unders ?? []).find((u) => u.x === x && u.z === z && deckOf(u) === deck);
    if (other) return (other.rot ?? 0) === (cell.rot ?? 0) ? other : null;
  }
  return null;
}

/**
 * Is this mouth already the far end of somebody else's tunnel?
 *
 * PAIRING IS A MATCHING, NOT A LOOKUP, and that is the whole of this function.
 * Asked cell by cell, "is there a mouth ahead of me" makes the middle of a chain
 * an entry AND an exit at once: four mouths in a row are three tunnels, the
 * middle pair swallows whatever the run was supposed to do between them, and
 * both halves of it draw as entries — which is the one thing about it you can
 * see, and it reads as the art not turning rather than as the wrong two ends
 * having found each other.
 *
 * What that cost on a live save: a mouth handed its crate four cells down the
 * row to the far pair's entry, straight over a LIFT standing in between. Every
 * box that arrived arrived correctly and the run looked like it was working —
 * the lift simply never carried anything, which is what an unbuilt lift looks
 * like too.
 *
 * The scan backwards stops at the FIRST mouth it meets for the same reason the
 * forward one does: anything further back would have met that one first, so it
 * is the only cell that could be claiming this one. And the answer alternates
 * down the chain — an entry's exit is spoken for, and the mouth after THAT is
 * free to open a tunnel of its own — which terminates because every step walks
 * strictly backwards along one axis.
 */
function tunnelClaimed(L, cell) {
  const behind = tunnelAhead(L, cell, true);
  if (!behind) return false;
  return !tunnelClaimed(L, behind);
}

/**
 * The far mouth this one hands to, or null if it is the far mouth itself.
 *
 * Both ends are laid facing the way the goods travel, so "am I an entry" is the
 * same question as "is there another mouth ahead of me, pointing the same way,
 * that nobody behind me has already claimed". Nothing is stored and nothing is
 * paired at build time — see `BUILD_KINDS.under` for why a partner id would not
 * survive the R key.
 */
export function tunnelExit(L, cell) {
  if (!cell || cell.kind !== 'under') return null;
  if (tunnelClaimed(L, cell)) return null;
  return tunnelAhead(L, cell);
}

/**
 * The conveyor cell standing on this tile, if any.
 *
 * The deck defaults to the FLOOR, which is what keeps every existing caller —
 * the ghost, the press, `dropGoods`' rail sweep, the crew — asking exactly the
 * question they have always asked. Anything that wants the overhead run has to
 * say so, and a lift answers on both because it is the one piece that spans.
 */
export function conveyorAt(L, x, z, deck = 0) {
  const cx = Math.round(x);
  const cz = Math.round(z);
  const cells = conveyorsOf(L);
  // A lift owns this square on BOTH storeys. Belts are listed before lifts in
  // `conveyorsOf`, so a single `.find()` returned a co-located roof belt first
  // and contradicted `conveyorFlow`, whose deck map deliberately lets the lift
  // overwrite that cell. Prefer the shaft explicitly, then answer the ordinary
  // deck lookup when there is no lift.
  return cells.find((c) => c.kind === 'lift' && c.x === cx && c.z === cz)
    ?? cells.find((c) => c.x === cx && c.z === cz && deckOf(c) === deck)
    ?? null;
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
/**
 * WHAT A LOADER MAY DO WITH WHATEVER IS STANDING ON A TILE.
 *
 * `{ pour, take }` — may goods go into the thing on this square, and may they
 * come out of it. Folded over everything covering the cell, because a tile can
 * hold more than one thing (a duct over a shelf) and the answer is about the
 * square rather than about one placement.
 *
 * It replaced THREE hand-written lists of kinds, in three files, and the bug
 * that produced is the one CLAUDE.md names about every enumeration with a
 * fallback: *a kind missing from one copy is a machine that works and a shop
 * that will not admit it does.* `unitOn` here, `conveyorPours` and
 * `conveyorIntake` in the renderer. The sim grew `armGather` and `armReap` when
 * a loader learned to collect a pen and a bed (docs/belts.md step 4b) and not
 * one of the three lists heard about it — so a loader bolted to a vat collected
 * from it perfectly and drew **no rail, no opening and no spur**, which reads as
 * the machine not being hooked up at all. The farm was the report; `station` was
 * missing from the take half too, and had been since loaders existed.
 *
 * So the port is declared on the KIND, beside `blocks`, `where` and `anchor`,
 * for their reason: it is behaviour, it is closed, and it is the same question
 * asked in `shared/` by three readers that must agree. A kind with no `arm` is
 * something a loader has nothing to do with, which is the safe direction and is
 * every kind that is not a unit — and a kind authored tomorrow says which of
 * the two it is on the row that defines it rather than in three files that have
 * never heard of it.
 *
 * Filed by `footprint` and never by `f.x === x`, which is the pen's doing: it
 * is the one kind with more than one cell, its record is the min corner, and a
 * loader against three of its four sides would find nothing standing there at
 * all. That bug was live in all three of the lists this replaced.
 *
 * What is deliberately NOT here is any condition about the PLACEMENT. A kind
 * says the port exists; whether it is open on the day is the caller's — a
 * stockroom shelf may be pulled from and a shop-floor one may not, and that is
 * `boh` on the unit rather than anything about shelving. Same split `where`
 * makes against `canKeep`.
 */
const NO_PORT = { pour: false, take: false };
const PORTS = new WeakMap();

export function armPorts(L, x, z) {
  if (!L) return NO_PORT;
  /**
   * Built once per layout and cached against it, for `conveyorFlow`'s reason:
   * this is asked per cell by the flow walk and per side by two loops in the
   * renderer, and the honest reading of "what covers this tile" is a sweep of
   * every fixture in the shop. A re-flow builds a new layout object, which is
   * what invalidates it — the same identity check every other cache here uses,
   * and the same trap: anything that MUTATES a fixture list in place rather
   * than re-flowing would hand out a stale map.
   */
  let grid = PORTS.get(L);
  if (!grid) {
    grid = new Map();
    for (const f of fixturesOf(L)) {
      const port = FIXTURES[f.kind]?.arm;
      if (!port) continue;
      for (const c of footprint(f.kind, f.x, f.z)) {
        const k = `${c.x},${c.z}`;
        const had = grid.get(k);
        grid.set(k, {
          pour: !!(had?.pour || port.pour),
          take: !!(had?.take || port.take),
        });
      }
    }
    PORTS.set(L, grid);
  }
  return grid.get(`${x},${z}`) ?? NO_PORT;
}

/**
 * Is a thing a loader can EMPTY INTO standing on this tile?
 *
 * The pour half of `armPorts`, kept as its own name because it is asked in two
 * places that mean something narrower than "a loader is interested in this
 * square": `conveyorFlow` uses it to decide a loader is a TERMINUS, and
 * `whatThisCosts` warns about a run that ends nowhere. A pen must not answer
 * yes to either — a loader collecting a vat still hands the box on down the
 * run, and calling it a terminus would end the line at the farm.
 */
export function unitOn(L, x, z) {
  return armPorts(L, x, z).pour;
}

const FLOW = new WeakMap();

function conveyorFlow(L) {
  const belts = L?.belts ?? [];
  // Loaders and sorters together: both derive their pass-through, and the only
  // difference is that a sorter also keeps one side back for its branch.
  const arms = [...(L?.arms ?? []), ...(L?.sorters ?? [])];
  const unders = L?.unders ?? [];
  const lifts = L?.lifts ?? [];
  // A packer sides with the BELTS and not with the machines, which is the one
  // structural consequence of its `rot` meaning what it means on a belt: it
  // knows its own direction, so the forward walk can start from it. Grouped with
  // the loaders it would be a cell whose flow has to be derived from a feeder,
  // and a run made of packers would then have no source at all — the degenerate
  // shape `conveyorFlow` warns about, arriving through a new door.
  const packers = L?.packers ?? [];
  const had = FLOW.get(L);
  if (had && had.belts === belts && had.arms === arms.length
    && had.armsRef === (L?.arms ?? []) && had.sortRef === (L?.sorters ?? [])
    && had.underRef === unders && had.liftRef === lifts
    && had.packRef === packers) return had.map;

  const cells = [...belts, ...packers, ...arms, ...unders, ...lifts];
  // A lift stands on both storeys, so it is filed under both — it is the one
  // cell a run on either deck may hand to.
  const at = new Map();
  for (const c of cells) {
    if (c.kind === 'lift') {
      at.set(`${c.x},${c.z},0`, c);
      at.set(`${c.x},${c.z},${CEILING}`, c);
    } else at.set(deckKey(c), c);
  }
  const map = new Map();

  /** This cell's conveyor neighbours, with which quarter turn each lies on. */
  const around = (c) => {
    const out = [];
    for (const r of [0, 1, 2, 3]) {
      const n = stepFrom(c, r);
      const other = at.get(`${n.x},${n.z},${n.deck}`);
      if (other) out.push({ ...n, r, arm: other.kind === 'arm', cell: other });
    }
    return out;
  };
  /** Is this neighbour known to hand TO us? Then it is not somewhere to hand on. */
  const feedsUs = (o, c) => {
    const to = map.get(o.cell.id);
    return !!to && to.x === c.x && to.z === c.z && deckOf(to) === deckOf(c);
  };
  /**
   * Is this option a straight continuation — the cell opposite it also being a
   * conveyor? That is what tells a run apart from a spur, and it is the only
   * handle a chain made ENTIRELY of loaders has.
   */
  const throughR = (c, r) => {
    const b = stepFrom(c, rot4(r + 2));
    return at.has(`${b.x},${b.z},${b.deck}`);
  };
  /**
   * The rise, if there is one and it is not already handing to us.
   *
   * Three guards, and each is its own way for two storeys to stop being two.
   *
   * A LIFT is never either end of it. It answers `at` on both decks — that is
   * what lets a run on either hand to it — so "the cell above me" is the shaft
   * itself and the answer would be a cell whose next is its own id: nothing
   * errors, the box arrives where it already is, and every walk over the run
   * walks that one cell until the tick loop stops. It is `liftTo`'s own guard,
   * said one storey along.
   *
   * And the FEEDER test is the vertical's copy of `feedsUs`, which is the one
   * that will not error and will not draw wrong either. Without it the floor
   * cell hands up, the ceiling cell hands down, both on the same square, for
   * ever — the loader ping-pong this function already warns about, stood on its
   * end. It is also the whole of what stops a COLUMN: two cells over one square
   * are the most that can exist, and this is what keeps them from being a run.
   */
  const risesTo = (c) => {
    if (c.kind === 'lift') return null;
    // A junction only looks up when it has been TOLD to — see `conveyorBranches`.
    if (c.kind === 'sorter' && c.riser !== true) return null;
    const n = acrossFrom(c);
    const other = at.get(`${n.x},${n.z},${n.deck}`);
    if (!other || other.id === c.id || other.kind === 'lift') return null;
    const back = map.get(other.id);
    if (back && back.x === c.x && back.z === c.z && deckOf(back) === deckOf(c)) return null;
    return n;
  };
  const choose = (c, backR) => {
    // A sorter's `rot` side is its BRANCH, never its straight-on. Without this
    // the derivation would happily pick the branch as the pass-through and the
    // piece would have one output that it used twice.
    const branch = c.kind === 'sorter' ? stepFrom(c, c.rot ?? 0) : null;
    /**
     * The side the box CAME FROM, which is never a way out.
     *
     * `feedsUs` is the general form of this and it cannot answer here, because
     * it reads a neighbour's straight-on out of `map` — and a junction reaches
     * this cell down a BRANCH, which is not that neighbour's straight-on and
     * therefore not in there. So a cell arrived at off a junction's side saw the
     * junction as open, and with nothing else beside it that is what it picked:
     * a two-cell tug of war with the piece that had just handed it the box.
     *
     * Which is `conveyorBranches`' own trap sprung from the other end — that
     * function drops any neighbour whose flow points back, so the branch it
     * just travelled disqualifies itself and the sorter ends up with no branch
     * at all. A loader bolted to a skip beside a junction is the build it
     * breaks, and both halves look perfectly wired.
     *
     * `backR` is the way ON, so the way BACK is its opposite. Null when the box
     * arrived from a lift, which is no quarter turn at all — nothing to exclude,
     * and the shaft is refused by `risesTo`'s own guard.
     */
    const cameFrom = backR === null || backR === undefined ? null : rot4(backR + 2);
    const open = around(c).filter((o) => !feedsUs(o, c)
      && o.r !== cameFrom
      && !(branch && o.x === branch.x && o.z === branch.z));
    /**
     * ...and with no way out ON THIS STOREY, the rise — docs/belts.md step 9.
     *
     * LAST, which is the entire opt-in. A loader in the middle of an aisle with
     * a duct crossing over it carries straight on exactly as it always did, and
     * the only machine that ever looks up is one that has run out of shop: the
     * endcap loader, which is the complaint this step exists for. A run down an
     * aisle used to stop there, because the only way back was a `lift` and a
     * lift wants a square — the square the endcap is standing on.
     *
     * `throughR` is never asked of it and must not be. It is what tells a run
     * apart from a spur, and a cell carrying on straight up because the cell
     * below it happens to be a conveyor is a column rather than a line.
     */
    if (!open.length) return risesTo(c);
    if (backR !== null) {
      const straight = open.find((o) => o.r === backR);
      if (straight) return { x: straight.x, z: straight.z, deck: straight.deck };
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
    return { x: pick.x, z: pick.z, deck: pick.deck };
  };

  // Seed: every plain belt answers for itself — and so does a PACKER, for the
  // same reason and by the same line.
  //
  // A packer's `rot` is its direction, exactly as a belt's is: it has no side to
  // aim at, so the key was free to keep the meaning it has everywhere else on a
  // run. Listed in `cells` but left out of this loop it was resolved by the
  // leftovers pass at the bottom instead — AFTER every derived cell around it —
  // so a sorter downstream of one was asked which way it carried on before
  // anything knew which way the box had been travelling, and guessed. On the
  // save it was found on it guessed its own feeder: the packer handed west into
  // the junction and the junction's straight-on pointed back east into the
  // packer.
  //
  // What that does NOT do is jam, which is why it needed an eye rather than a
  // sweep: `conveyorBranches` refuses a neighbour that feeds you, so the three
  // real legs were all still branches and boxes still went down them. The run
  // worked. What you could see was the junction occasionally handing a box back
  // the way it came, and there is nothing in the game that says a word about it.
  const queue = [];
  for (const b of [...belts, ...packers]) {
    map.set(b.id, stepFrom(b, b.rot));
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
    map.set(u.id, far ? { x: far.x, z: far.z, deck: deckOf(far) } : stepFrom(u, u.rot ?? 0));
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
    const f = stepFrom(a, a.rot ?? 0);
    const other = at.get(`${f.x},${f.z},${f.deck}`);
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
    if (back && back.x === a.x && back.z === a.z && deckOf(back) === deckOf(a)) continue;
    map.set(a.id, { x: f.x, z: f.z, deck: f.deck });
    queue.push(a);
  }

  // ...and walk forward. A loader reached from something that hands to it is a
  // loader with a feeder, which is the one fact the derivation was missing.
  const walk = () => {
    while (queue.length) {
      const c = queue.shift();
      // BOTH ways out of a junction. A sorter that only propagated its
      // straight-on would leave everything down its branch unseeded — and the
      // cells that then fall back to the per-cell guess are a whole line of
      // loaders that quietly decide, one by one, to hand sideways into the run
      // next door.
      const ways = [map.get(c.id)];
      const br = c.kind === 'sorter' ? stepFrom(c, c.rot ?? 0) : null;
      if (br && at.has(`${br.x},${br.z},${br.deck}`)) ways.push(br);
      /**
       * ...and EVERY OTHER SIDE, because that is what a junction has been since
       * it became a four-way and this loop was still walking the two it had
       * when it was a T.
       *
       * `conveyorBranches` is what actually routes a crate, and it takes every
       * neighbour that is not the straight-on and is not feeding in — `rot` only
       * decides which goes first. So a sorter's incidental exits are ways out
       * the sim sends boxes down and the walk never travelled, which is this
       * loop's own note about the named branch, said about the sides nobody
       * typed: they fall through to the per-cell guess at the bottom of this
       * function, and for a loader aimed at a shelf or a machine that guess is
       * "terminus".
       *
       * What it costs is the shop the piece is for. A junction with an aisle of
       * loaders coming off one side — each aimed at the appliance it feeds —
       * has every cell of that aisle declared a dead end, so the first loader
       * takes a box and hands on to nobody. The sorter goes on offering it the
       * branch and the whole row is fed one machine deep, which reads as a
       * loader that will not pass anything through, and every piece in it is
       * aimed correctly the entire time.
       *
       * Derived off `around`/`feedsUs` rather than by calling
       * `conveyorBranches` — that function asks `conveyorNext` of its
       * neighbours, which is a call back into this one, and the lift's own note
       * two screens down is about the afternoon that took the server out.
       */
      if (c.kind === 'sorter') {
        for (const o of around(c)) {
          if (feedsUs(o, c)) continue;
          ways.push({ x: o.x, z: o.z, deck: o.deck });
        }
      }
      // ...and a junction's RISE, for the same reason its named branch is here:
      // a way out the walk does not travel is a way out whose loaders never get
      // a feeder, so they fall through to the per-cell guess and a whole duct
      // decides, one cell at a time, which way it runs.
      if (c.kind === 'sorter' && c.riser === true) {
        const up = acrossFrom(c);
        const on = at.get(`${up.x},${up.z},${up.deck}`);
        if (on && on.id !== c.id && on.kind !== 'lift') ways.push(up);
      }
      for (const to of ways) {
        if (!to) continue;
        const next = at.get(`${to.x},${to.z},${deckOf(to)}`);
        if (!next || !derivedFlow(next.kind) || map.has(next.id)) continue;
        // Which side it arrived from — and a crate off a LIFT arrived from
        // below or above, which is no quarter turn at all. `null` is the honest
        // answer and the one `choose` already has a branch for: there is no
        // straight-on to prefer, so the cell picks by the ordinary rules. Made
        // to guess a compass side instead, the first cell of every overhead run
        // would carry straight on in whatever direction the lift happened to
        // sit.
        const fromR = c.kind === 'lift' ? undefined : [0, 1, 2, 3].find((r) => {
          const a = stepFrom(next, r);
          return a.x === c.x && a.z === c.z && a.deck === deckOf(c);
        });
        map.set(next.id, choose(next, fromR === undefined ? null : rot4(fromR + 2)));
        queue.push(next);
      }
    }
  };
  walk();

  /**
   * ...and THEN the lifts, which is a second pass and has to be.
   *
   * A lift is the only cell whose answer is not on its own storey, and which
   * way it carries is read off whoever hands to it: a floor run arriving means
   * up, a ceiling run arriving means down. Build one at the end of an aisle and
   * it lifts, one at the end of the duct and it drops, and nobody configures
   * anything — which is the whole reason it has no `rot`, since `rot` is the
   * field the R key clears (`FIXTURES.lift`).
   *
   * It was resolved in the seeding loop above, where the only feeder it could
   * safely ask was a DECLARED one — a plain belt or a tunnel mouth, aimed by
   * somebody, able to answer with nothing else known. Asking a loader there is
   * unbounded recursion into this very function and it took the server down
   * once. So a shaft fed only by loaders fell through to the guess, for ever,
   * whatever was actually plugged into it — and the guess is "up off the
   * floor", so a lift at the end of a duct with a loader feeding it went UP,
   * which is nowhere. What that reads as is a crate parking on a lift and
   * refusing to come down.
   *
   * The recursion is not a fact about lifts, it is a fact about WHEN. After the
   * walk every loader and sorter the run can reach has an answer sitting in
   * `map`, so the same question is a lookup rather than a call — and the
   * feeders that could not be asked at seeding time are exactly the ones that
   * are known now. Then the walk runs again, from the lifts, so an overhead
   * run's own loaders are derived off the storey the shaft actually chose.
   */
  /**
   * A shaft's exit on a named storey — a cell BESIDE it up there, never its own
   * square.
   *
   * Its own square on the far deck is the lift again — it answers `conveyorAt`
   * on both storeys, which is what lets a run on either one hand to it — so
   * "straight up" would be a cell whose `next` is its own id. Nothing errors
   * and the box arrives where it already is, for ever.
   *
   * Lifted out of `liftTo` because a shaft you SET has to pick its exit exactly
   * as a derived one does; written twice, an authored direction would be a
   * direction with its own idea of where the box goes, and the pair would
   * disagree in a shop with two candidate cells.
   */
  const liftOut = (f, deck) => {
    // THE SIDE YOU AIMED AT FIRST, then rotation order.
    //
    // A shaft has up to four ways out on the deck it lands on, and until R
    // meant anything here it took the lowest-numbered one — so which cell a
    // descending crate carried on into was decided by an enum, and the only way
    // to change it was to demolish whichever neighbour happened to win. On the
    // save this came off, a lift landing beside a belt to its east and a tunnel
    // mouth to its north always chose the belt, and the north leg could not be
    // built at all.
    //
    // Preferring rather than pinning is the whole care needed: `rot` is free on
    // every shaft ever built (it defaults to 0, which is east, which is what the
    // scan already tried first), so no existing lift moves — and a shaft aimed
    // at a wall, at its own feeder or at nothing still falls through to the scan
    // rather than becoming a terminus, which is `faceAlong`'s `keep` said about
    // a machine: an aim that only ever WORKS cannot make a shop stop working.
    for (const r of [rot4(f.rot ?? 0), 0, 1, 2, 3]) {
      const n = anchorTile(f.x, f.z, r);
      const other = at.get(`${n.x},${n.z},${deck}`);
      if (!other || other.id === f.id || other.kind === 'lift') continue;
      // Never back onto a feeder, which is a two-cell tug of war. Derived cells
      // downstream of this shaft have no answer yet, so they cannot look like
      // one; the ones that do are genuinely pointing in.
      const back = map.get(other.id);
      if (back && back.x === f.x && back.z === f.z && deckOf(back) === deck) continue;
      return { x: n.x, z: n.z, deck };
    }
    // A shaft with nothing beside it on the far deck is an ordinary thing to
    // have half-built, so it is a TERMINUS rather than a hang.
    return null;
  };

  const liftTo = (f) => {
    /** Where this neighbour hands its crate, without asking anybody. */
    const goes = (o) => {
      const out = [map.get(o.id)];
      const br = o.kind === 'sorter' ? stepFrom(o, o.rot ?? 0) : null;
      if (br && at.has(`${br.x},${br.z},${br.deck}`)) out.push(br);
      return out;
    };
    // Fed from BOTH — a loop that goes up one shaft and down this one — takes
    // the floor's answer, arbitrarily and on purpose: some answer beats none,
    // and the second feeder is a run the player can see is joined to the wrong
    // end.
    /**
     * ...unless you SAID, which is the one case the derivation cannot get
     * right and knows it.
     *
     * Fed from one side, reading the feeder is better than any setting: build
     * a shaft at the end of an aisle and it lifts, one at the end of a duct and
     * it drops, and nobody configures anything. Fed from BOTH — a floor run and
     * a duct arriving on the same square, which is the ordinary way two levels
     * of one loop rejoin — there is no answer to derive, so the note below
     * takes the floor's arbitrarily. Arbitrary is fine as a fallback and is not
     * fine as the only option: half the shops that build it want the other one,
     * and what they get is a shaft that lifts crates away from the run they
     * were trying to merge into.
     *
     * Which also gives the pass-through for nothing. A shaft told DOWN hands to
     * a floor cell beside it, so a crate that arrived along the floor simply
     * carries on into that cell and a crate that arrived overhead descends the
     * shaft into the same one — two feeds, one exit, no second concept.
     */
    if (LIFT_WAYS.includes(f.way)) return liftOut(f, f.way === 'up' ? CEILING : 0);
    let from = null;
    for (const d of [0, CEILING]) {
      for (const r of [0, 1, 2, 3]) {
        const n = anchorTile(f.x, f.z, r);
        const other = at.get(`${n.x},${n.z},${d}`);
        // Never another lift. A shaft's far cell is never one (see below), so a
        // lift cannot be handed a box by one, and asking would be the same
        // ordering problem one storey along.
        if (!other || other.id === f.id || other.kind === 'lift') continue;
        if (goes(other).some((w) => w && w.x === f.x && w.z === f.z && deckOf(w) === d)) {
          from = d;
          break;
        }
      }
      if (from !== null) break;
    }
    // Nobody hands to it at all — a shaft still being built, or one reached
    // only through cells the walk could not resolve. Up off the floor, down off
    // the ceiling: the storey it is standing on is the honest guess about which
    // way it carries.
    const deck = from === null
      ? (deckOf(f) === CEILING ? 0 : CEILING)
      : (from === CEILING ? 0 : CEILING);
    return liftOut(f, deck);
  };
  for (const f of lifts) {
    map.set(f.id, liftTo(f));
    queue.push(f);
  }
  walk();

  // Anything the walk never reached has no belt upstream of it at all. Resolve
  // one, then PROPAGATE from it the same way — otherwise every cell of a
  // beltless chain answers independently and they disagree with each other.
  for (const c of arms) {
    if (map.has(c.id)) continue;
    /**
     * ...unless it is a LOADER EMPTYING INTO A UNIT, which hands on to nobody.
     *
     * A loader whose `rot` names a shelf, a machine or a skip is a terminus:
     * what arrives on it goes into that unit, and there is no "next cell" to
     * answer with. Made to guess one anyway it names whichever neighbour it has
     * — and with nothing feeding it, the only neighbour is usually the junction
     * you built it off. `conveyorBranches` then drops any neighbour whose flow
     * points back at it, so the loader is refused as a way out: no blade drawn,
     * no light on that side, and nothing ever sent down it.
     *
     * Which is the exact build the skip exists for — a sorter, a loader beside
     * it, a bin beside that — reading as a sorter that cannot see the machine
     * bolted to it. The loader is aimed correctly and the rubbish routing is
     * working; it simply never gets a box. Only the walk's leftovers are
     * answered this way: a loader with a feeder was resolved above and is part
     * of a run whatever it pours into.
     */
    // A CEILING loader is a terminus on the same terms now: it reads `rot` as
    // the first neighbouring floor fixture it serves. Left out, an overhead
    // loader with no feeder is the beltless leftover this branch is about and
    // guesses a conveyor neighbour instead.
    const out = c.kind === 'arm'
      ? anchorTile(c.x, c.z, c.rot ?? 0)
      : null;
    /**
     * ...unless there is a DUCT OVER IT, and this is the one place step 9 had
     * to reach into a rule that predates it.
     *
     * "A loader emptying into a unit hands on to nobody" is true right up to
     * the moment the same square gained a way out, and the shop it is wrong
     * about is the shop the whole step exists for: an aisle stocked by a row of
     * loaders, an endcap at the end of it, and a duct overhead to take away
     * what the shelves would not have. A row of loaders with no plain belt in
     * it is exactly what never reaches the forward walk — nobody has a feeder,
     * so every cell of it lands here — and the endcap is aimed at its shelf, so
     * it was declared a terminus one line before anything asked about the rise.
     *
     * Which is the same build working or not depending on whether there
     * happened to be a belt somewhere upstream, and nothing on screen could say
     * so: an endcap resolved through `choose` gets the duct, an endcap resolved
     * here does not, and both are a loader with a duct over it and a box that
     * has stopped.
     *
     * A rise makes it a cell with somewhere to hand on, which is all this
     * branch was ever asking. The units still go first — that is `armSwing`'s
     * ladder, not this map, and it is untouched.
     */
    if (out && !at.has(`${out.x},${out.z},${deckOf(c)}`) && unitOn(L, out.x, out.z)) {
      /**
       * ...UNLESS THERE IS A DUCT OVER IT, and it belongs here and nowhere
       * earlier — which is the whole of what this branch got wrong once.
       *
       * "A loader emptying into a unit hands on to nobody" stopped being true
       * when the same square gained a way out. Asked BEFORE `choose` though, it
       * is a different and much worse sentence: every loader the walk never
       * reached rises, including all seven of an aisle stocked one machine per
       * shelf with the return duct running over the top of it. Which is not a
       * subtle failure — the run stops being a run, each cell posts its box
       * straight up, and the riser marks draw a row of seven lifts where there
       * should be one at the end.
       *
       * `choose` below already rises as its LAST resort, so the ordinary end of
       * a chain is handled there. What is left for here is only the loader that
       * `choose` would never be asked about: one whose `rot` names a shelf, a
       * machine or a skip, which was a terminus and now has somewhere to go.
       */
      const up = risesTo(c);
      map.set(c.id, up ?? null);
      if (up) { queue.push(c); walk(); }
      continue;
    }
    map.set(c.id, choose(c, null));
    queue.push(c);
    walk();
  }

  FLOW.set(L, {
    belts,
    arms: arms.length,
    armsRef: L?.arms ?? [],
    sortRef: L?.sorters ?? [],
    underRef: unders,
    liftRef: lifts,
    packRef: packers,
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
    if (far) return { x: far.x, z: far.z, deck: deckOf(far) };
    /**
     * ...and the far end may come up on the OTHER STOREY, which is the whole of
     * what the toggle buys: a span that arrives under an aisle can hand its box
     * to the duct overhead instead of onto the floor in front of it.
     *
     * `riser` is the sorter's own field and the ask is the same one, for the
     * same reason: a duct over a mouth is a route across the shop that happens
     * to pass over that square, so it is chosen rather than derived — otherwise
     * laying a return leg would silently re-point every tunnel it flew over.
     *
     * Guarded on there BEING a cell up there, or a mouth switched on over bare
     * roof is a terminus and the run simply stops — which is the one failure
     * that reads as the toggle having broken the tunnel rather than as an empty
     * ceiling.
     */
    if (cell.riser === true) {
      const up = acrossFrom(cell);
      if (conveyorAt(L, up.x, up.z, up.deck)) return up;
    }
    return stepFrom(cell, cell.rot);
  }
  // The one cell that changes storey. Read off the flow map rather than worked
  // out here, because which STOREY it carries to depends on who feeds it and
  // that is not known until the walk has run — and because R aims the shaft at
  // one of the four ways out up there, which is the same walk's answer. See
  // `liftTo` and `liftOut`.
  if (cell.kind === 'lift') return conveyorFlow(L).get(cell.id) ?? null;
  if (!derivedFlow(cell.kind)) return stepFrom(cell, cell.rot);
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
  const b = stepFrom(cell, cell.rot ?? 0);
  return conveyorAt(L, b.x, b.z, b.deck) ? b : null;
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
  const named = stepFrom(cell, cell.rot ?? 0);
  const out = [];
  for (const r of [0, 1, 2, 3]) {
    const n = stepFrom(cell, r);
    const other = conveyorAt(L, n.x, n.z, n.deck);
    if (!other) continue;
    if (straight && n.x === straight.x && n.z === straight.z
      && deckOf(straight) === n.deck) continue;
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
    const back = to && to.x === cell.x && to.z === cell.z && deckOf(to) === deckOf(cell);
    if (back && (!isNamed || !derivedFlow(other.kind))) continue;
    out.push({ x: n.x, z: n.z, deck: n.deck });
  }

  /**
   * ...and the fifth, which is straight up or straight down — step 9.
   *
   * `riser` IS THE ASK, and it shipped automatic for one afternoon on the
   * argument that you do not aim a branch: `conveyorBranches` takes every
   * neighbour that is not the straight-on and is not feeding it, and `rot` only
   * decides which goes first, so standing a junction where two storeys meet
   * reads like the choosing. That argument is wrong about the one axis it was
   * being applied to, and the difference is what you were pointing at when you
   * built the thing. A belt beside a junction was laid *at* the junction. A duct
   * over one is a route across the shop that happens to pass over it — and a
   * return leg passes over everything, which is the whole reason to have it.
   *
   * A real shop found it the same day: a junction feeding an aisle of fifteen
   * shelves, with the return duct crossing over its square on the way home.
   * While a shelf could take the goods the keen test held (`sorterOut` only
   * splits across lines that WANT the box, and a duct that serves nothing is
   * never keen) — and the moment the aisle filled, nothing was keen and a third
   * of everything went up the return leg to park at the end of it. Every box
   * that did arrive arrived correctly, which is the "sorter that does not sort"
   * report exactly.
   *
   * Off is every junction ever built. Same two guards as `risesTo` besides —
   * never a shaft, never something already pointing at us — because a branch
   * that is also a feeder is a two-cell tug of war, and at a junction that is
   * the likely one.
   */
  const up = acrossFrom(cell);
  const above = cell.riser === true ? conveyorAt(L, up.x, up.z, up.deck) : null;
  if (above && above.id !== cell.id && above.kind !== 'lift'
    && !(straight && straight.x === up.x && straight.z === up.z
      && deckOf(straight) === up.deck)) {
    const to = conveyorNext(L, above);
    const back = to && to.x === cell.x && to.z === cell.z && deckOf(to) === deckOf(cell);
    if (!back) out.push(up);
  }
  // The side `rot` names goes first — a tie is settled by what you aimed it at.
  out.sort((a, b) => (a.x === named.x && a.z === named.z ? -1 : 0)
    + (b.x === named.x && b.z === named.z ? 1 : 0));
  return out;
}

/**
 * WHO HANDS ON TO THIS CELL — the merge, which is the other half of a junction
 * and the half that happens to you without buying anything.
 *
 * `conveyorBranches` is the split: one line in, several ways out, and a sorter
 * bought to choose between them. This is the same T read the other way round —
 * two lines in, one way out — and it is the shape a run actually grows into
 * first, because two aisles feeding one dock is what a second aisle IS. It
 * happens on plain belt, with nothing bought and nothing configured, which is
 * exactly why it had no controls: there is no piece to hang them on.
 *
 * Derived rather than stored, for the reason branches are: who feeds a cell is a
 * fact about the RUN, and a list kept beside it is wrong the first time somebody
 * turns a belt.
 *
 * The four sides AND the square above or below, which is `conveyorBranches`'
 * enumeration and for its reason — a duct handing down into a floor run is a
 * feeder every bit as much as the belt beside it, and one left out here is a
 * line that can never be given priority. A tunnel arrives through its own far
 * mouth, which is one of the four.
 */
export function conveyorFeeders(L, cell) {
  if (!cell) return [];
  const out = [];
  const deck = deckOf(cell);
  for (const n of [stepFrom(cell, 0), stepFrom(cell, 1), stepFrom(cell, 2), stepFrom(cell, 3),
    acrossFrom(cell)]) {
    const other = conveyorAt(L, n.x, n.z, n.deck);
    if (!other || other.id === cell.id) continue;
    const to = conveyorNext(L, other);
    if (to && to.x === cell.x && to.z === cell.z && (to.deck ?? 0) === deck) out.push(other);
  }
  return out;
}

/**
 * WHETHER THIS CELL'S OWN ROTATION NAMES A MAIN ROAD, which is the one thing
 * `straight` and `leg` rest on and is not true of every conveyor.
 *
 * A belt's `rot` is where it points and a mouth's is where its span runs, so on
 * those two the feeder directly behind is the line that does not turn. On a
 * sorter `rot` is the branch it favours on the way OUT, on a loader it is the
 * shelf it stocks, and on a shaft it is the side it lands on — three pieces
 * whose rotation is spoken for, and asking them which feeder is "behind" gives a
 * confident answer to a question they were never told. At a sorter it is worse
 * than useless: the feeder opposite the branch is very often the LEG, so
 * "let the straight line through" would let the leg through, and the shop would
 * look exactly like a junction obeying its setting.
 */
export const mergeAims = (cell) => !!cell && !derivedFlow(cell.kind) && cell.kind !== 'lift';

/**
 * ...and which of the feeders is the one carrying STRAIGHT ON through the cell.
 *
 * That is what makes R the control here rather than a compass list in a menu:
 * turn the junction cell and you have said which of the two lines meeting on it
 * is the main road; the other one is the leg.
 *
 * Null when nothing feeds it from behind — a merge with two legs and no main
 * road — and null on every piece `mergeAims` refuses. `mergeHolds` treats both
 * the same way and yields to nobody, which is what stops a setting that cannot
 * be answered from favouring a line picked by list order.
 */
export function mergeStraight(L, cell) {
  if (!mergeAims(cell)) return null;
  const back = stepFrom(cell, rot4((cell.rot ?? 0) + 2));
  return conveyorFeeders(L, cell)
    .find((f) => f.x === back.x && f.z === back.z && deckOf(f) === back.deck) ?? null;
}

/**
 * How a conveyor cell settles a MERGE, which is one setting with four answers.
 *
 * `default` is every junction ever built and is what the network already did:
 * whichever box is nearer the seam goes, and two arriving level are settled by
 * id. The other three are the player saying it out loud — `straight` for the
 * line that carries on through, `leg` for the one that turns in, `alternate`
 * for take-turns whatever else is happening.
 *
 * It belongs to the cell being ENTERED whatever that cell is, which is why the
 * field rides on every conveyor kind rather than on belt alone. A merge is not a
 * fact about a piece you bought — it is what happens to the square two runs
 * happen to arrive at, and in a real shop that square is most often the sorter,
 * because a sorter is what people stand where lines meet. `straight` and `leg`
 * are the two that need `mergeAims`; `default` and `alternate` can be answered
 * by anything.
 *
 * A closed set for `SORTER_ROUTES`' reason, and NOT that set: a split chooses
 * between ways out and a merge chooses between ways in, so the two are different
 * questions with confusingly similar words. Sharing one list would put "let the
 * crew sort it" on a piece that never looks in a box.
 */
export const MERGE_ROUTES = ['default', 'straight', 'leg', 'alternate'];

export const mergeRoute = (c) => (MERGE_ROUTES.includes(c?.merge) ? c.merge : 'default');

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
      // ...on the storey the way out names. Read off the floor, this walk stops
      // dead at the first overhead cell — so `conveyorMeets` answers "that run
      // serves nothing" about a whole duct, and every judgement built on it (a
      // junction's keen test, the skip guard on a loader's lift) is made about
      // a run the walk never saw.
      const on = conveyorAt(L, to.x, to.z, deckOf(to));
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
  // The storey is the THIRD axis of this polyline, not a label on its ends. A
  // lift's leg is zero long in x,z, so measured flat it is skipped by the guard
  // below and the box is drawn on the far deck the tick it sets off — the ride
  // is the one part of an overhead run you can actually watch, and it would not
  // exist. `deck` comes back as a fraction for exactly that reason.
  // Three storeys rather than two, and the third is the tunnel's. A point may
  // sit at `BASEMENT` even though no CELL ever does — the span is the one leg
  // of a path with nothing standing on either end of it.
  const d = (p) => (p?.deck === CEILING ? CEILING : (p?.deck === BASEMENT ? BASEMENT : 0));
  if (!pts?.length) return { x: 0, z: 0, deck: 0, leg: 0, k: 0 };
  if (pts.length === 1) return { x: pts[0].x, z: pts[0].z, deck: d(pts[0]), leg: 0, k: 0 };
  let left = Math.max(0, at);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z, d(b) - d(a));
    if (seg <= 0) continue;
    if (left <= seg || i === pts.length - 1) {
      const k = Math.min(1, left / seg);
      return {
        x: a.x + (b.x - a.x) * k,
        z: a.z + (b.z - a.z) * k,
        deck: d(a) + (d(b) - d(a)) * k,
        leg: i - 1,
        k,
      };
    }
    left -= seg;
  }
  const last = pts[pts.length - 1];
  return { x: last.x, z: last.z, deck: d(last), leg: pts.length - 2, k: 1 };
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
  const lifts = L?.lifts ?? [];
  // A packer is an ordinary cell of a line. It does not BREAK one, for the
  // reason a loader does not: it stands in the run, so breaking at machines
  // would cut an aisle into one-cell lines and rebuild the per-cell shape this
  // function exists to have deleted.
  const packers = L?.packers ?? [];
  const had = LINES.get(L);
  if (had && had.belts === belts && had.arms === arms
    && had.sorters === sorters && had.unders === unders && had.lifts === lifts
    && had.packers === packers) return had.out;

  const cells = [...belts, ...arms, ...sorters, ...unders, ...lifts, ...packers];
  const grid = new Map();
  for (const c of cells) {
    if (c.kind === 'lift') {
      grid.set(`${c.x},${c.z},0`, c);
      grid.set(`${c.x},${c.z},${CEILING}`, c);
    } else grid.set(deckKey(c), c);
  }
  const cellOf = (p) => (p ? grid.get(`${p.x},${p.z},${deckOf(p)}`) ?? null : null);

  // Every way out of every cell, which is one for all of them but a junction.
  const ways = new Map();
  /**
   * ...and WHICH STOREY each cell is handed its boxes on, which is the one
   * thing `cellOf` throws away and the one thing a shaft needs.
   *
   * `conveyorNext` answers a point — an x, a z and a deck — and a lift answers
   * `conveyorAt` on both storeys, so resolving that point to a cell collapses
   * "the duct hands to the shaft" and "the aisle hands to the shaft" into the
   * same fact. `deckOf` on the shaft itself cannot tell them apart either: it
   * is a field on the placement and reads 0 whichever end you mean.
   */
  const inDecks = new Map();
  const arrives = (p, o) => {
    const d = deckOf(p);
    const seen = inDecks.get(o.id) ?? [];
    if (!seen.includes(d)) seen.push(d);
    inDecks.set(o.id, seen);
  };
  for (const c of cells) {
    const out = [];
    const raw = conveyorNext(L, c);
    const n = cellOf(raw);
    if (n) {
      out.push(n);
      arrives(raw, n);
    }
    if (c.kind === 'sorter') {
      for (const b of conveyorBranches(L, c)) {
        const o = cellOf(b);
        if (!o) continue;
        arrives(b, o);
        if (!out.some((w) => w.id === o.id)) out.push(o);
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

  /**
   * The storey a crate is on when it REACHES a shaft that heads a line.
   *
   * Everywhere else in a path the answer is the cell before it. A lift that
   * opens a line has no cell before it — nothing feeds it, or two things do —
   * so the honest answer is read off who hands to it: a shaft carries between
   * storeys, so if anything feeds it from the deck its exit is NOT on, that is
   * the ride, and the box is drawn taking it. Fed only from the deck it hands
   * out on, it is a pass-through and there is no ride to draw.
   */
  const liftEntry = (f, exit) => {
    const other = exit === CEILING ? 0 : CEILING;
    return (inDecks.get(f.id) ?? []).includes(other) ? other : exit;
  };

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
    /**
     * ...and the polyline, which is NOT one point per cell wherever a lift is.
     *
     * A lift hands to a cell beside it on the other storey, so the leg from one
     * to the other changes x,z and deck at once — and `alongPath` interpolates
     * a leg, so the box flies the diagonal: up and over, through the wall of
     * its own shaft, rather than up the shaft and out along the duct. It is the
     * one hop in the whole system anybody actually watches, and cutting the
     * corner is the single thing that makes it read as a cheat.
     *
     * So a riser is inserted, and it goes over the SHAFT: the change of storey
     * happens on the lift's own square, because the shaft is the only thing in
     * the shop that can carry a box between two of them. Which of the pair that
     * is depends on which way the goods are going, and getting it wrong is only
     * visible in one direction — put on the near cell always, a box going UP
     * rises in the shaft and a box coming DOWN steps off the end of the duct
     * into thin air and descends beside it, then slides along the floor to the
     * shaft it never entered. Half of it looks perfect, which is why it shipped.
     *
     * `dist` charges both legs, which keeps the crate's one number and the
     * drawn polyline measuring the same journey — they are the same number in
     * two units otherwise, and every jam behind a lift would sit a tile out.
     *
     * WHICH MAKES THIS LIST LONGER THAN `cells`, and that is the whole reason
     * it is built here rather than mapped off the path afterwards. It was
     * mapped, and the two halves shipped disagreeing: `dist` charged the riser
     * and `pts` never had one, so `alongPath` was handed two tiles of travel to
     * spend on a leg 1.41 long and the box flew the diagonal anyway — the
     * corner-cutting this note is about, still there, with the fix for it
     * sitting five lines above unused. `dist[i]` is the arc length of `pts` up
     * to cell `i`'s own point either way, which is the only thing any reader of
     * the two asks of them.
     */
    /**
     * ...and WHICH STOREY the box is on at each cell of it, which is `deckOf`
     * everywhere except a shaft NOBODY IS RIDING.
     *
     * `deck` on a lift is a fact about the placement and reads 0 whichever end
     * of the shaft you mean, which is the right answer for both real rides:
     * going up the box starts on the floor and going down it ends there, so a
     * path that puts the shaft's own point on the floor is telling the truth
     * about half of each and the other half is the riser below.
     *
     * A shaft used as a PASS-THROUGH is the case that has no floor half at all.
     * A lift told `up` hands to a cell beside it on the CEILING, so a duct
     * arriving overhead simply carries on — the whole reason `way` gives the
     * pass-through away for nothing — and the drawn path dived four metres to
     * the floor and climbed straight back for it. What that reads as is a lift
     * grabbing a box, taking it down to a storey with nothing on it, and
     * throwing it back up onto the rail: the shape of a routing bug, when the
     * routing was right the whole time. It cost two extra tiles of travel and a
     * `wholeLegs` hold at either end of a hop that never happens.
     *
     * So a shaft that hands out on the storey it was handed the box on stays on
     * that storey, and NOTHING else moves — an ascent, a descent and a shaft
     * with no exit at all are `deckOf` to the byte, which is what keeps this off
     * the queueing that a real ride is choreographed by.
     */
    const decks = path.map((c) => deckOf(c));
    for (let i = 0; i < path.length; i++) {
      const c = path[i];
      if (c.kind !== 'lift') continue;
      const out = ways.get(c.id) ?? [];
      if (!out.length) continue;
      const exit = deckOf(out[0]);
      const entry = i > 0 ? decks[i - 1] : liftEntry(c, exit);
      if (entry === exit) decks[i] = entry;
    }
    const dist = [0];
    const pts = [{ x: path[0].x, z: path[0].z, deck: decks[0] }];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const flat = Math.abs(b.x - a.x) + Math.abs(b.z - a.z);
      const rise = decks[i] !== decks[i - 1];
      /**
       * A SPAN DIPS, which is what makes a tunnel a lift pointed downward.
       *
       * The leg between two mouths was one flat edge and the crate was hidden
       * along it by a rule of its own. Two corner points at `BASEMENT` turn it
       * into the shape a shaft already has — down over the entry, across
       * underground, up at the exit — so the crate's own `deck` fraction is the
       * descent, `alongPath` interpolates it like any other leg, and the piston
       * is drawn from the same number the lift's carrier is.
       *
       * `dist` charges all three legs for `conveyorLines`' own stated reason:
       * the crate's one number and the drawn polyline have to measure the same
       * journey, or every queue behind a tunnel stands a tile out. It is still
       * one `dist` step longer than a cell, so `wholeLegs` goes on holding the
       * queue at the mouth and a span still carries exactly one box.
       */
      const span = !rise && a.kind === 'under' && b.kind === 'under'
        && tunnelExit(L, a)?.id === b.id;
      if (span) {
        pts.push({ x: a.x, z: a.z, deck: BASEMENT });
        pts.push({ x: b.x, z: b.z, deck: BASEMENT });
        dist.push(dist[i - 1] + 1 + flat + 1);
      } else if (rise && flat) {
        const shaft = a.kind === 'lift' ? a : b;
        const flatDeck = a.kind === 'lift' ? decks[i] : decks[i - 1];
        pts.push({ x: shaft.x, z: shaft.z, deck: flatDeck });
        dist.push(dist[i - 1] + 1 + flat);
      } else {
        dist.push(dist[i - 1] + (flat || 1));
      }
      pts.push({ x: b.x, z: b.z, deck: decks[i] });
    }
    const line = {
      id: path[0].id,
      cells: path,
      // Which storey the box is on at each of them. Only ever interesting at a
      // shaft, and `deckOf` is a lie at exactly those — so every reader that
      // asks a LINE what deck one of its cells is on has to ask this.
      decks,
      dist,
      len: dist[dist.length - 1],
      pts,
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

  const out = { lines, byCell, order, feeds: from, ways: to };
  LINES.set(L, { belts, arms, sorters, unders, lifts, packers, out });
  return out;
}

const LOOPS = new WeakMap();

/**
 * Where the network eats itself: the cycles, and the pairs that hand to each
 * other.
 *
 * Everything else about a conveyor is a fact about ONE CELL, and every readout
 * in the game says it that way — the slats lie along the path, the chevrons
 * point at `conveyorNext`, the end pips cap a terminus. All of which is
 * correct, all of which is legible, and none of which can say the one thing
 * that actually goes wrong when somebody wires a corner up: a ring is four
 * correct arrows. Standing in the shop looking at it, every cell is doing what
 * it says, and the crates go round for ever.
 *
 * So this is deliberately the first thing about a run that is a fact about the
 * NETWORK. Two answers, and they are not the same claim:
 *
 *   a **cycle** is a set of lines you can leave and come back to. It is not an
 *   error and must never be drawn as one — a loop with loaders down it is a
 *   thing people build on purpose, and docs/belts.md is explicit that the boxes
 *   going round ARE the buffer and the one signal the shop is backed up. What
 *   it is is a fact you cannot see, so it is worth saying out loud;
 *
 *   a **tug** is two cells that hand to each other, and that one is always a
 *   mistake. Nothing rides a two-cell ring — the pair simply passes a box back
 *   and forth for the rest of the save — and this file's own notes call it out
 *   four separate times as the shape a derivation falls into. It is a cycle of
 *   length two and it is listed separately for exactly that reason: read as one
 *   more loop it would be drawn in the colour that means "on purpose".
 *
 * Both are derived rather than stored, and cached against the same five arrays
 * `conveyorLines` watches — a re-flow builds new ones, which is what makes a
 * purchase or a demolition land.
 *
 * @returns {{cycles: object[][], inCycle: Set<string>, tugs: object[][]}}
 *          `inCycle` is keyed by LINE id; `tugs` are pairs of cells.
 */
export function conveyorLoops(L) {
  const cut = conveyorLines(L);
  const had = LOOPS.get(L);
  if (had && had.cut === cut) return had.out;

  // Tarjan, over the line graph rather than the cell graph. A line is the unit
  // everywhere else in here and it is the unit a player reads — "this run comes
  // back on itself" is the sentence, not "these nineteen squares do".
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  const inCycle = new Set();
  let next = 0;

  // Iterative rather than recursive: a shop can hold hundreds of lines and this
  // is walked from a render frame.
  for (const root of cut.lines) {
    if (index.has(root.id)) continue;
    const work = [{ line: root, i: 0 }];
    index.set(root.id, next);
    low.set(root.id, next);
    next += 1;
    stack.push(root);
    onStack.add(root.id);
    while (work.length) {
      const frame = work[work.length - 1];
      const outs = cut.ways.get(frame.line.id) ?? [];
      if (frame.i < outs.length) {
        const w = outs[frame.i];
        frame.i += 1;
        if (!index.has(w.id)) {
          index.set(w.id, next);
          low.set(w.id, next);
          next += 1;
          stack.push(w);
          onStack.add(w.id);
          work.push({ line: w, i: 0 });
        } else if (onStack.has(w.id)) {
          low.set(frame.line.id, Math.min(low.get(frame.line.id), index.get(w.id)));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent.line.id, Math.min(low.get(parent.line.id), low.get(frame.line.id)));
      }
      if (low.get(frame.line.id) !== index.get(frame.line.id)) continue;
      const group = [];
      for (;;) {
        const l = stack.pop();
        onStack.delete(l.id);
        group.push(l);
        if (l.id === frame.line.id) break;
      }
      // A component of one is only a cycle if it hands to ITSELF, which is what
      // a ring `conveyorLines` had to cut arbitrarily comes back as.
      const self = group.length === 1
        && (cut.ways.get(group[0].id) ?? []).some((w) => w.id === group[0].id);
      if (group.length < 2 && !self) continue;
      cycles.push(group);
      for (const l of group) inCycle.add(l.id);
    }
  }

  // ...and the tugs, which are asked of CELLS. A pair that hands to each other
  // is usually two cells of one line — or, in the shape that keeps happening, a
  // sorter whose named branch is the cell feeding it — so the line-level answer
  // above cannot draw the distinction the pair needs.
  const cells = [...(L?.belts ?? []), ...(L?.arms ?? []), ...(L?.sorters ?? []),
    ...(L?.unders ?? []), ...(L?.lifts ?? []), ...(L?.packers ?? [])];
  const at = new Map();
  for (const c of cells) {
    if (c.kind === 'lift') {
      at.set(`${c.x},${c.z},0`, c);
      at.set(`${c.x},${c.z},${CEILING}`, c);
    } else at.set(deckKey(c), c);
  }
  const exits = (c) => {
    const out = [];
    const n = conveyorNext(L, c);
    if (n) out.push(n);
    if (c.kind === 'sorter') out.push(...conveyorBranches(L, c));
    return out.map((w) => at.get(`${w.x},${w.z},${deckOf(w)}`)).filter(Boolean);
  };
  const tugs = [];
  const paired = new Set();
  for (const c of cells) {
    for (const w of exits(c)) {
      if (w.id === c.id) continue;
      const key = c.id < w.id ? `${c.id}|${w.id}` : `${w.id}|${c.id}`;
      if (paired.has(key)) continue;
      if (!exits(w).some((b) => b.id === c.id)) continue;
      paired.add(key);
      tugs.push([c, w]);
    }
  }

  const out = { cycles, inCycle, tugs };
  LOOPS.set(L, { cut, out });
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
  const packers = L?.packers ?? [];
  let had = MEETS.get(L);
  if (!had || had.belts !== belts || had.arms !== arms || had.sorters !== sorters
    || had.packers !== packers
    || had.shelves !== (L?.shelves ?? null) || had.stations !== (L?.stations ?? null)
    || had.bins !== (L?.bins ?? null) || had.pens !== (L?.pens ?? null)
    || had.plots !== (L?.plots ?? null)) {
    had = {
      belts,
      arms,
      sorters,
      packers,
      shelves: L?.shelves ?? null,
      stations: L?.stations ?? null,
      bins: L?.bins ?? null,
      // Watched by identity like the rest, and what that buys is nothing beyond
      // a re-flow — this answers WHICH fixtures a run meets, never what is in
      // them, so a pen filling up does not invalidate anything here.
      pens: L?.pens ?? null,
      plots: L?.plots ?? null,
      byCell: new Map(),
    };
    MEETS.set(L, had);
  }
  const hit = had.byCell.get(cell.id);
  if (hit) return hit;

  const out = {
    shelves: [], stations: [], bins: [], pens: [], plots: [],
  };
  const seen = new Set();
  const take = (list, from, key) => {
    for (const u of from ?? []) {
      if (u.x !== key.x || u.z !== key.z || seen.has(u.id)) continue;
      seen.add(u.id);
      list.push(u);
    }
  };
  // ...and the same for anything that takes more than one cell, which is the
  // pen. `u.x === key.x` is "is this its MIN CORNER" — right about one cell in
  // four of a 2x2 — so a loader stood against three of a pen's four sides would
  // see nothing there. Exactly the `fixtureAt` trap docs/pens.md lists among the
  // eight places "a fixture is a tile" was load-bearing, arriving on a conveyor.
  const takeBig = (list, from, key) => {
    for (const u of from ?? []) {
      if (seen.has(u.id) || !covers(u, key.x, key.z)) continue;
      seen.add(u.id);
      list.push(u);
    }
  };
  for (const c of conveyorRun(L, cell)) {
    if (c.kind !== 'arm') continue;
    for (const n of armReach(c)) {
      take(out.shelves, L?.shelves, n);
      take(out.stations, L?.stations, n);
      take(out.bins, L?.bins, n);
      // The farm. These two are the only entries in here a loader takes goods
      // OUT of and never puts any in — a pen and a bed produce, so there is
      // nothing to fill them with.
      takeBig(out.pens, L?.pens, n);
      take(out.plots, L?.plots, n);
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
    for (const n of armReach(c)) {
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
  for (const p of L.pens ?? []) out.push({ kind: 'pen', ...p });
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
  for (const k of L.packers ?? []) out.push({ kind: 'packer', ...k });
  // ...and `unders`, which was the fourth to be left out and had been since the
  // day tunnels shipped: a mouth did not survive a shell stamp and nothing
  // warned about stranding one.
  for (const u of L.unders ?? []) out.push({ kind: 'under', ...u });
  for (const f of L.lifts ?? []) out.push({ kind: 'lift', ...f });
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
  if (!def.flow || keeping) return null;
  const deck = deckOf(spec);
  /**
   * A SHAFT swaps what is standing on either storey, because it is the cell on
   * both of them.
   *
   * `conveyorAt` gives a lift's square to the lift on each deck — that is what
   * lets a run on either one hand to it — so a duct cell left standing on that
   * square is not a second run, it is a cell nothing in the game can ever
   * address again. Which is exactly what you get by building in the obvious
   * order: lay the ceiling run, then drop a shaft under it to bring the goods
   * down. The crate rides the lift and everything looks right, and the orphan
   * belt sits there for the rest of the save.
   *
   * The other direction already behaved: a duct dragged ACROSS a lift is
   * refused on that one cell and the run is connected through the shaft anyway,
   * because the cells either side address the square and get the lift. This is
   * the half where the second cell survives, and the fix is to treat the storey
   * above a new shaft the way `conveyorSwap` already treats the square under
   * any other conveyor — one press, `removeFixture`'s own refund, no way to
   * print money by swapping.
   *
   * ABOVE the tile test rather than after it, which is the whole of why the
   * first draft of this was silent. A shaft goes on ordinary floor, so `ground`
   * is `T.FLOOR` and the belt-stamp guard below returns before anything asks
   * about the storey — and a swap that is not reported by `canPlace` is a
   * demolition the ghost never mentioned.
   */
  const above = spec.kind === 'lift' ? conveyorAt(L, x, z, CEILING) : null;
  if (above && !ignores(ignoreId, above.id) && above.kind !== spec.kind) {
    return { ok: true, warn: `replaces the ${FIXTURES[above.kind]?.label?.toLowerCase() ?? 'run'} overhead` };
  }
  // Overhead, the tile says NOTHING. A ceiling cell stamps no ground — that is
  // the whole of what it gives back — so `T.BELT` is not there to refuse the
  // second one, exactly as `blocked` is not there to refuse a second belt. This
  // is the only thing standing between an overhead run and an unlimited stack of
  // them on one square, which is the trap `verify:catalog` already asserts about
  // every walk-over kind.
  if (deck !== CEILING && ground !== T.BELT) return null;
  const here = conveyorAt(L, x, z, deck);
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
  if (ignores(ignoreId, here.id)) return { ok: true };
  // Only between the two conveyor kinds, and never for the same kind: a belt
  // over a belt is a press that takes money and changes nothing.
  if (here.kind !== spec.kind) {
    return { ok: true, warn: `replaces the ${FIXTURES[here.kind]?.label?.toLowerCase() ?? 'belt'} that is there` };
  }
  return null;
}

export function canPlace(L, spec, { ignoreId = null, keeping = false, warn: wantWarn = true } = {}) {
  const def = FIXTURES[spec.kind];
  if (!def) return no(`"${spec.kind}" is not something you can build`);

  const x = Math.round(spec.x);
  const z = Math.round(spec.z);

  if (isProp(spec.kind)) {
    if (x < 1 || z < 1 || x >= L.w - 1 || z >= L.h - 1) return no('off the edge of the world');
    return canPlaceProp(L, def, x, z, ignoreId, keeping);
  }

  /**
   * EVERY cell it would cover, which for all but a pen is the one you named.
   *
   * The three tests below were written against a tile because a fixture was a
   * tile, and each of them is silently wrong about a block: a 2x2 whose far
   * corner is off the map, or on a belt, or under a shelf, would be accepted on
   * the strength of its origin being clear — and then `occupy` would stamp the
   * cells anyway, which is a fixture built through another one.
   */
  const cells = footprint(spec.kind, x, z);
  for (const c of cells) {
    if (c.x < 1 || c.z < 1 || c.x >= L.w - 1 || c.z >= L.h - 1) {
      return no('off the edge of the world');
    }
  }

  /**
   * A CEILING conveyor asks the roof, and the roof has two questions on it.
   *
   * Everything below this line is about the floor — what the ground is made of,
   * what is standing on it, whether the queue can still reach the till — and not
   * one of those is a fact about a duct four metres up. Asked of an overhead run
   * they are all the wrong question with a plausible answer: a run could not
   * cross its own aisle, could not pass over a shelf, and could not leave the
   * building's floor plan, which is the entire reason to lay one.
   *
   * So the two that DO apply are asked here and the rest are skipped. It has to
   * be indoors, because a ceiling is a thing a roof gives you and open sky does
   * not — and the run may not stack, which `conveyorSwap` answers on its own
   * deck since there is no tile stamp up there to do it.
   */
  if (deckOf(spec) === CEILING) {
    /**
     * ...and "a conveyor" is three of the five, which is a distinction the
     * refusal has to draw rather than imply.
     *
     * `def.flow` was the test, and it reads as "is this a conveyor" — true of a
     * lift and a tunnel, neither of which has a storey to be on: see
     * `goesOverhead`. Named in the refusal, because the two that fail here fail
     * for a reason a player can act on, and "only a conveyor can go on the
     * ceiling" said over a Lift is the game denying what the tool is.
     */
    if (!def.overhead) {
      return no(def.flow
        ? `a ${def.label.toLowerCase()} goes on the floor — the ceiling takes ${overheadKinds()}`
        : 'only a conveyor can go on the ceiling');
    }
    /**
     * ...and the roof is a PLACEMENT rule, never a keeping one.
     *
     * This is `canKeep`'s own bug, one storey up, and it shipped with step 8
     * because the two rules that survived the skip above were both read as
     * facts about the duct. A roof is not: it is a fact about the walls, and
     * enclosure in this game is shop-wide and ALL-OR-NOTHING — take enough of a
     * wall out and `computeIndoor` answers zero indoor cells, not fewer. So one
     * accidental hole in an outside wall failed this test for every overhead
     * cell in the building at once, and `compose` sheds what it cannot keep:
     * the entire duct dropped and refunded on one press.
     *
     * A full refund is why it does not read as theft. What you lose is the
     * build, and what you see is your whole ceiling disappearing for a gesture
     * the game called a warning — the same sentence `canKeep` is already
     * written on the floor half of the shop.
     */
    if (!keeping && !cells.every((c) => insideStore(L, c.x, c.z))) {
      return no('there is no roof there');
    }
    const swapUp = conveyorSwap(L, def, spec, T.BELT, x, z, ignoreId, keeping);
    if (swapUp) return swapUp;
    if (conveyorAt(L, x, z, CEILING)) return no('there is already a run overhead');
    return { ok: true };
  }

  // Two questions where there used to be one, because a tile used to answer
  // both. What the ground is made of is `tiles`; whether something already
  // stands on it is `blocked`. A plot digs the ground, so it asks about grass;
  // everything else stands on the floor.
  //
  // Asked of the WORST cell rather than of the origin: a block is only as
  // placeable as the least placeable square under it, so `ground` is any cell
  // that fails and `taken` is any cell that is occupied. For a one-cell kind
  // both reduce to exactly what they were.
  const ok = (g) => (def.where === 'indoor' ? BUILDABLE_INDOOR.has(g)
    : (def.where === 'any' ? (BUILDABLE_INDOOR.has(g) || BUILDABLE_OUTDOOR.has(g))
      : BUILDABLE_OUTDOOR.has(g)));
  /**
   * ...AND A FIXTURE IS NOT IN ITS OWN WAY, WHICH THE GROUND TEST NEVER KNEW.
   *
   * `blockedAt` has forgiven `ignoreId` since there was an `ignoreId` — you are
   * not standing in your own way when you are the thing being lifted — and the
   * TILE half of the same question was never told. That is invisible for every
   * kind that stamps nothing, which is all but two of them: a shelf leaves
   * `T.FLOOR` behind it, so moving one asks about floor and gets floor.
   *
   * A `plot` stamps `T.PLOT` and a `belt` stamps `T.BELT`, and neither is in
   * either buildable set — deliberately, since that stamp is the only thing
   * refusing a SECOND one on the cell (a non-blocking kind is invisible to
   * `blocked`). So a rack asked to stand where it already stands was refused by
   * its own stamp, with the message the cell was occupied. **Upgrading, moving
   * or turning a bed has never worked**: `upgradeFixture` goes through
   * `repositionFixture`, which re-judges the placement, and the Lit Rack rung
   * has been unbuyable for as long as it has existed. Nothing said so — the
   * refusal names the cell, so it reads as the shop being full.
   *
   * The belt half was papered over by `conveyorSwap`, which is a bespoke
   * function about conveyors that happens to return before this test. This is
   * the general rule it is a special case of.
   *
   * Whether the ground is BUILDABLE is the only thing being asked, and a stamp
   * you made is proof you were allowed to build here — so it needs no
   * reconstruction of what lies underneath, which is the version of this that
   * would have to guess between the overlay, the shell and bare grass.
   */
  const ownStamp = (c, g) => !!ignoreId && fixturesOf(L).some((f) => ignores(ignoreId, f.id)
    && FIXTURES[f.kind]?.ground === g
    && footprint(f.kind, Math.round(f.x), Math.round(f.z)).some((q) => q.x === c.x && q.z === c.z));
  /**
   * The tile, with your own stamp lifted off it — which is what the cell is
   * made of once the thing being moved is in the air.
   *
   * Answered as plain shell ground rather than by reading the overlay back,
   * because the only thing downstream asks is whether it is buildable and the
   * fixture standing here is proof that it was. Reconstructing the real base
   * would mean guessing between `layout.ground`, the shell and bare grass, and
   * getting that wrong is a fixture you can lift and not put back.
   */
  const seen = (c) => {
    const g = tileAt(L, c.x, c.z);
    if (ok(g) || !ownStamp(c, g)) return g;
    return insideStore(L, c.x, c.z) ? T.FLOOR : T.GRASS;
  };
  const bad = cells.find((c) => !ok(seen(c))) ?? cells[0];
  const ground = seen(bad);
  const taken = cells.some((c) => blockedAt(L, c.x, c.z, ignoreId));
  const anyIn = cells.some((c) => insideStore(L, c.x, c.z));
  const allIn = cells.every((c) => insideStore(L, c.x, c.z));

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
    if (!keeping && !allIn) return no('that has to go inside the shop');
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
    if (!keeping && anyIn) return no('plots go outside, on the grass');
    if (taken) return no('something is already there');
    if (!BUILDABLE_OUTDOOR.has(ground)) return no('you can only dig into bare grass');
  }

  // Everything above is physics and decides `ok`. Everything below is a
  // SENTENCE, and it is by far the more expensive half — `whatThisBlocks`
  // floods the whole map from the door (twice, when something really is cut
  // off) and the till branch walks a queue lane. A caller who is not going to
  // read the string should not pay for it: see `canKeep`, which is asked of
  // every placement in the shop on every re-flow.
  if (!wantWarn) return { ok: true };
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
  const clash = (L.props ?? []).some((p) => !ignores(ignoreId, p.id) && p.x === x && p.z === z);
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
 *
 * ...and it asks for no WARNING, which is where the re-flow's cost was.
 *
 * A warning is a sentence for somebody holding a ghost. Nothing re-applying a
 * shop it already has can act on one — all three callers in `compose` read
 * `.ok` and nothing else — and computing it is not free: `whatThisBlocks`
 * floods the entire map from the front door for every placement, and a second
 * time whenever anything at all is unreachable. A furnished shop is ~160
 * placements, so a single press of the mouse paid for ~200 whole-map floods and
 * threw every one of them away. That was 86% of a re-flow, and a re-flow is
 * what a build press *is* — 46ms of a 49ms stall on a middling shop, growing
 * with the square of how much you have built.
 *
 * Pass `warn: true` if you ever want one back; the option is left open rather
 * than deleted because the sentence itself is still correct, it simply has no
 * reader here.
 */
export function canKeep(L, spec, opts = {}) {
  return canPlace(L, spec, { warn: false, ...opts, keeping: true });
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
  const size = sizeOf(spec.kind);
  // Every cell the thing being placed would stand on, as a set, so "treated as
  // already there" covers the whole of a block rather than its corner.
  const mine = new Set(footprint(spec.kind, x, z).map((c) => `${c.x},${c.z}`));
  // Where a person could stand, with the thing being moved treated as already
  // gone and the thing being placed treated as already there.
  const open = (tx, tz) => WALKABLE.has(tileAt(L, tx, tz))
    && !blockedAt(L, tx, tz, ignoreId)
    && !(def.blocks && mine.has(`${tx},${tz}`));

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
    const a = anchorTile(x, z, spec.rot ?? 0, size);
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
    // A RUN is belts, loaders, sorters and tunnel mouths, and `L.belts` is only
    // the first of those. Named that way this fired on the commonest join in
    // the shop — a belt pointing at the loader it feeds — which is a warning
    // that goes off whatever you do, and one of those is a warning nobody
    // reads. It is also what made the real one below worthless.
    const onRun = (tx, tz) => (tx === x && tz === z)
      || [L.belts, L.arms, L.sorters, L.unders, L.packers]
        .some((list) => (list ?? []).some((c) => c.x === tx && c.z === tz));
    const atUnit = (tx, tz) => (L.shelves ?? []).some((sh) => sh.x === tx && sh.z === tz)
      || (L.stations ?? []).some((st) => st.x === tx && st.z === tz)
      || (L.bins ?? []).some((bn) => bn.x === tx && bn.z === tz);
    /**
     * A unit is the end of a run for a LOADER and for nothing else.
     *
     * A belt carries and never hands off: `stepBelts` exits into conveyor cells
     * only, so a run pointed straight at a shelf, a machine or a skip simply
     * stops on its last cell with the box sitting on it. This test used to
     * count that as connected, which is the green-ghost rule inverted — the
     * preview promising a join the sim has never had — and it is the one thing
     * that could have said otherwise. A live shop ran both its skips off a
     * sorter and stood eleven crates of rot beside them, with `conveyorMeets`
     * answering "no bin on this network" everywhere and every loader in the
     * building therefore refusing to lift rubbish at all. Nothing anywhere said
     * a word, because the build that caused it had been declared fine.
     */
    const holds = (tx, tz) => spec.kind === 'arm' && atUnit(tx, tz);

    if (def.flow.out != null) {
      const o = anchorTile(x, z, (spec.rot ?? 0) + def.flow.out);
      if (!onRun(o.x, o.z) && !holds(o.x, o.z)) {
        // The wrong answer worth naming, because it is the one that LOOKS
        // right: a run aimed squarely at the thing it was laid to fill.
        if (atUnit(o.x, o.z)) return 'it runs past that — only a loader puts goods in';
        return spec.kind === 'belt'
          ? 'it runs into nothing — the next belt goes on the square it points at'
          : 'nothing in front of it to put goods into';
      }
    }
    if (def.flow.in != null) {
      const i = anchorTile(x, z, (spec.rot ?? 0) + def.flow.in);
      if (!onRun(i.x, i.z)) return 'nothing behind it to take goods from';
    }
  }

  // An arm asks the same question of all four sides at once, because it works
  // between any two of them. Two warnings rather than one, since "it has
  // nothing to take from" and "it has nowhere to put things" are different
  // mistakes and telling somebody the wrong one sends them to the wrong side.
  // A loader sits in the run and unloads sideways, so what it needs beside it is
  // something that TAKES goods. Without any it is a belt that cost four times as
  // much — which is a thing you may build (it still carries crates) and must be
  // told about.
  //
  // Shelving is not the whole of that list, and naming only shelving is the
  // `STOCK_KINDS` trap in a warning: a loader put beside a skip — which is the
  // one placement that lets rubbish ride at all — was told it had nothing to
  // fill, on the very press that fixes the shop. Machines are the same claim,
  // and `armLand` already pours into all three.
  //
  // ...and the farm is the other half of that same correction. A loader beside a
  // pen or a bed COLLECTS — it is the one thing on the list it takes goods out
  // of rather than putting them in — so a run laid out to the field was told it
  // had nothing to do on precisely the press that automates the walk. The
  // wording says "work" rather than "fill" because both directions are in the
  // list now, and a warning that names the wrong one is worse than a vague one.
  if (def.works) {
    const around = FACING.map((f) => ({ x: x + f.dx, z: z + f.dz }));
    const unitish = (c) => [L.shelves, L.stations, L.bins, L.plots]
      .some((list) => (list ?? []).some((u) => u.x === c.x && u.z === c.z))
      // A pen is 2x2, so its far cells are not its record's `x, z`.
      || (L.pens ?? []).some((u) => covers(u, c.x, c.z));
    if (!around.some(unitish)) return 'nothing beside it to work — it will just carry crates past';
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
    const clash = (L.checkouts ?? []).some((c) => !ignores(ignoreId, c.id)
      && c.serveAt?.x === serve.x && c.serveAt?.z === serve.z);
    if (clash) return 'another till already serves that spot';
    // Measured against a shop with this till already standing in it, which used
    // to mean cloning the tile array. A mask is cheaper to say "and this one" to.
    const probe = { ...L, blocked: withBlocked(L, x, z) };
    // The same walk the line itself will take, so the warning cannot promise a
    // pile-up the lane then bends its way out of. A till in a corner used to be
    // warned about on the strength of a straight run it never had.
    const others = new Set((L.checkouts ?? [])
      .filter((c) => !ignores(ignoreId, c.id) && c.serveAt)
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
      // Every cell it stands on. Corner-only, a 2x2 being moved leaves three
      // quarters of itself in the mask, so the flood answers about a shop with
      // a hole in it and the warning fires on the placement that is fine.
      if (ignores(ignoreId, f.id)) {
        for (const c of footprint(f.kind, f.x, f.z)) before[c.z * L.w + c.x] = 0;
      }
    }
  }
  // Which is also the baseline: what the shop is like with this thing lifted
  // and not yet put down, which is exactly what the player is looking at.
  const after = def.blocks ? Uint8Array.from(before) : before;
  if (def.blocks) {
    for (const c of footprint(spec.kind, spec.x, spec.z)) after[c.z * L.w + c.x] = 1;
  }

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
    if (ignores(ignoreId, f.id)) continue;
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
