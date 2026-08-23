# Handoff — the vertical hand-off (docs/belts.md step 9)

Paste this whole file to the next agent.

---

## The complaint, in one picture

An aisle with shelving down both sides and an endcap on the end. A conveyor
runs the length of it, a loader per unit, and then it **stops** — because the
only way back is a `lift`, and a lift needs a square, and the square at the end
of the aisle is the endcap. You cannot have the endcap and the return leg.

So a run down an aisle is a dead end today unless you plan the shaft in before
you plan the shop. Step 8 gave the shop a second storey and then made reaching
it cost a floor tile, which is the thing the storey was bought to stop.

## What to build

**Up is a WAY OUT, not a fixture.** The cell directly above a floor cell — same
x, same z, `deck: CEILING` — becomes a fifth exit that any conveyor kind can
take, and the same downward. Three consequences, and they are the whole feature:

1. **A sorter can sort UP.** A junction on the floor with a duct over it sends
   the goods it does not want overhead. That is the return leg with no square
   spent on it.
2. **A loader at the end of a line sends up when there is nowhere else.** It
   already has an off-ramp of last resort (`armSwing` — pads, then the tile it
   faces, then any side); a duct overhead goes into that ladder, above the
   ground drop, because a box put on a run is better than a box put on the
   floor.
3. **A ceiling loader stocks the shelf beneath it**, which already works
   (`armReach`) and is the other half of the pitch the player made: a roof
   loader over an endcap serves the endcap, and the aisle keeps its tile.

The `lift` piece stays. It is what you build when you want a shaft you can see
and a run that changes storey somewhere with nothing under it; this is what you
build when the square is spoken for.

## Read first

- `docs/belts.md` step 8 — the storey, the deck rule, and the traps it already
  cost. Everything below assumes it.
- `shared/build.js`, from `CEILING` down to `conveyorLines`. Four functions
  decide what a way out is and all four are same-deck by construction.
- `scripts/verify-ceiling.js` — 195 assertions, and the sections it already has
  are the shape yours should take.

## Where it lands

| Where | What |
|---|---|
| `shared/build.js` | `stepFrom` is same-deck by construction — you need its vertical sibling. `conveyorFlow`'s `around`/`throughR`/`feedsUs`/`choose`, `conveyorBranches`, `conveyorNext` for a loader's last-resort, `conveyorLines`' `ways` |
| `server/sim/index.js` | `armSwing`'s off-ramp ladder, `sorterOut`/`sorterWants` (the pool already carries `deck`), `beltExit`'s hop already charges the rise |
| `client/render/scene.js` | a join mark and a riser between the two decks; the sorter's blade for an up-branch; the loader's chute pointed the other way |
| `scripts/verify-ceiling.js` | new sections — see below |

## The eight things that will bite

**1. `stepFrom` is the same-deck rule and it is load-bearing.** It is what a
second storey IS (`deckKey`, docs/belts.md step 8). Do not relax it. Add a
separate `acrossFrom(c)` that names the same square on the other deck, and make
every place that enumerates ways out ask for it *explicitly*. A vertical
neighbour that arrives through the four-way loop is two storeys merging again,
which draws as a conveyor that teleports and reads as one that works.

**2. `feedsUs` must cover the vertical, or you get a two-cell tug of war** — the
floor cell hands up, the ceiling cell hands down, both on the same square, for
ever. It is the loader ping-pong `conveyorFlow` already warns about, standing on
its end, and it will not error.

**3. `throughR` decides "is this a straight continuation", and a rise is not
one.** A run that carries on straight up because the cell below it is also a
conveyor is a column, not a line.

**4. A vertical hop is a leg of length 1 with `flat === 0`,** so
`conveyorLines`' riser branch is not hit and must not be — the box goes straight
up over its own square, which is already what `alongPath` interpolates. Check
`dist` still agrees: `verify:ceiling` section 6 asserts the arc length of `pts`
up to cell `i` equals `dist[i]`, and that assertion is your canary.

**5. `beltExit`'s hop already adds 1 for a deck change** — so a vertical
hand-off is charged correctly today, and the `wholeLegs` all-or-nothing guard
will hold the box at the end of the line until the rise can be made whole. That
is right. Do not special-case it.

**6. A loader's up-ramp goes ABOVE the ground drop and BELOW the units.** The
order in `armSwing` is a ladder of preferences and it is argued in
docs/belts.md: shelving first (that is what the machine is for), then a run
(goods stay in the system), then a pad, then the floor it faces. Putting the
rise below the ground drop makes it dead code in every shop with walkable floor
beside it — which is every shop.

**7. `conveyorAt` answers for a LIFT on both decks.** A floor cell asking "what
is above me" gets the lift back if it is standing on one. That is correct and it
is also a cell whose `next` may be your own square. Guard it the way `liftTo`
does.

**8. The renderer has no vertical anything.** Every mark on a run lies on a tile
EDGE, and this hand-over has no edge — it is the same square twice, four metres
apart, which is exactly the problem the overhead loader's chute already has
(`DUCT_CHUTE`, `addConveyorPaths`). Reuse that shape: a collar, not a tube. And
`conveyorPath`'s `in`/`out` are x,z vectors, so a cell whose only exit is up
falls back to its own facing and draws its carriers along a leg nothing uses.

## What `verify:ceiling` has to claim

Its existing control sections are unchanged and must stay green — a shop with no
overhead cell is the old game, and that is what says this is opt-in.

- **A duct over a run changes nothing until somebody asks it to.** This is the
  sharpest control in the feature: after step 8, a ceiling run laid over a floor
  run is two networks that do not touch (section 3). Make "up" a way out and
  they touch by default unless the rise is *chosen*. Decide what chooses it — a
  sorter aimed up, a loader with nowhere else — and assert that a plain belt
  under a duct still hands along the floor and nothing else.
- **The endcap case, end to end.** An aisle, a loader at the end of it with a
  shelf in front and a duct above, and the box goes UP rather than onto the
  floor. Paired with: with no duct above, it still drops on the floor exactly as
  it does today.
- **A sorter sends its rejects up**, and a box that a floor branch WANTS still
  goes to the floor branch — the rise must not outrank a keen line, or it is the
  `homeFull` spread bug wearing a storey.
- **No column.** Three conveyor cells stacked over one square is not a run, and
  nothing may resolve as one.
- **A box that went up comes down somewhere**, or the return leg is a way of
  losing stock on the roof. Conservation, and the `binOrphans`/`clearRails`
  sweeps still reach it.
- **The ride.** Same claim section 6 makes about a lift: a crate part way
  between storeys is over the square it rose from, sampled every tick.

## How to check your work

```
npm run verify                 # 31 sweeps, all green before you start
npm run verify:ceiling         # 195 assertions, the ones you are extending
npm run verify:belts           # the floor half, which must not move
```

`SNS_DB` takes a copy of the live database (`sqlite3 data/game.db "VACUUM INTO
'/tmp/x.db'"`) — the sweeps author content rows, and the shared shop is usually
open.

Ask Will to look at anything visual. Do not drive a browser to judge it.
