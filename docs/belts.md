# Belts — the trip nobody walks

Status: **steps 1, 2, 2b, 3, 3b, 4, 4b and 7–11 built.** Steps 5–6 and 12
proposed.

Steps 1–3 are the build. Steps 5–6 and 12 are written down so the shape is
argued now rather than discovered later, and should not be started.

What shipped: the `belt`, `arm` and `sorter` kinds, the tile they stamp, the
downstream-first tick with backpressure, the catalog rows, a `scroll` motion kind
for the slats, and `verify:belts` — 325 assertions. One thing is NOT in it and is
called out where it belongs below: the belt is placed a cell at a time rather
than dragged as a run (step 1's "laying a run").

---

## The hole

**Every case of stock in this shop is moved by a robot with legs, and the legs
are the whole cost.**

That is not a complaint about the crew — it is what the last five steps of
docs/workers.md have each been about, one at a time:

- `ferry` ([server/sim/staff.js:1850](server/sim/staff.js#L1850) is its
  neighbour, `unload`) exists because every case comes off one dock, so in a big
  building the walk to the far aisle is paid **once per armful** — eight hires in
  single file, which reads as bad pathing and is bad logistics.
- The `packs` rung exists because a bay of part-crates makes a hire leave with
  four units and walk the shop three times, looking busy the whole way.
- The `routes` rung exists because `plots.find(...)` is list order, so a farmhand
  stood on a ripe bed walks the length of the field to bed 1.
- `carry_mult` exists to make the trip carry more.
- `arranges` exists to make the trip shorter at the far end.

Five features, one sentence: *the walk is the product, and the shop has been
buying ways to make it cheaper.* What it has never been able to buy is **not
taking it**.

And the shop already knows the walk is the bottleneck, in the one place that says
so out loud. `bayRoom` collapsing is what stops the shop ordering; a full
drop-off is what leaves the crew stood about with full arms; `hasSomewhere`
gates the farm on there being anywhere for the harvest to go. All three are the
same jam, and all three clear at exactly the rate somebody can walk.

So there is a game about automating a grocery shop in which the only automation
is *hiring more people to walk*.

---

## The shape

> A belt is the walk. An arm is the hands. You buy them separately, and between
> them they are a stocker who never gets tired, never takes a charge, and costs
> money once instead of every morning in `payWages`.

That decomposition is the whole design, and it is what makes belts a *decision*
rather than a strict upgrade:

| | A hire | A belt + an arm |
|---|---|---|
| Costs | a wage, every morning | cash once, and floor space for ever |
| Goes | anywhere, including where you have not thought of yet | exactly where you laid it |
| Copes with | a shop you rearranged this afternoon | nothing you did not draw |
| Scales by | hiring, which is linear | laying more, which is also linear but paid up front |

A shop that lays belts is betting that its floor plan has stopped changing. That
is a real bet, it is the bet Factorio is made of, and this game already has the
thing that makes losing it hurt: a re-flow fires on **every wall segment of a
drag**, so a player who is still building is a player whose belts are in the
wrong place.

---

## The decision that makes this affordable: a belt carries CRATES

This is the load-bearing decision in the document, and it is the one that decides
whether this is three steps or thirty.

[docs/lanes.md](docs/lanes.md) §5 already costed belts, correctly, on the
assumption that a belt is somewhere goods live:

> A belt is a **seventh place goods can live.** `verify:orphans` enumerates the
> six that exist: a board, a crate, your hands, a shoulder, a hopper, a tray, and
> a van […] Its stated failure mode is not "the bin is wrong" but "the bin has
> never heard of shoulders".

Every word of that is right, and it is the reason belts have been deferred. The
bill it names is conservation (`removePlayer`, firing, `saveState` /
`restoreStaff`, `homeSupply`, `binOrphans`), spoilage, ordering, and the merge
rules — four subsystems, each of which fails *silently* rather than visibly.

**A belt that carries crates does not send that bill.**

A crate is already one of the six. It is an entry in `this.deliveries`
([server/sim/index.js:1341](server/sim/index.js#L1341)), it already has a
position, it already spoils, `stockCrates()`
([server/sim/index.js:10928](server/sim/index.js#L10928)) already keeps the whole
list for three readers, `homeSupply`
([server/sim/index.js:4926](server/sim/index.js#L4926)) already counts it as
supply, and `binOrphans` ([server/sim/index.js:3768](server/sim/index.js#L3768))
already sweeps it. A crate riding a belt is a crate **whose position is written
by the belt instead of by whoever put it down**.

So the seventh place is not created. There is one new field on an object that
already exists, and every loop in the sim that walks `deliveries` goes on being
right without being told anything.

It is also the better game. Crates are the unit of logistics in this shop —
`CRATE_UNITS`, `packCrate` ([server/sim/index.js:9511](server/sim/index.js#L9511)),
`wholeCrate`, `crateBoard` ([server/sim/index.js:9694](server/sim/index.js#L9694))
— so a line of boxes trundling from the dock to the back of the shelving is what
the shop's own vocabulary already says. Loose units on a belt would be a second
granularity nothing else in the building uses.

**What it costs, and it is worth saying out loud:** belt density stops being the
texture. Factorio is partly a game about items-per-second on a belt, and a crate
is a chunky, slow, countable thing. That is a genuine loss and it is bought back
by the arm and the sorter, which are where the per-second thinking goes.

---

## What is already built that this rides on

| Piece | Where | What it gives free |
|---|---|---|
| A non-blocking fixture kind | `plot`, `prop-floor` ([shared/build.js:108](shared/build.js#L108)) | The precedent for a fixture people walk over. A belt must never be `blocks: true` or a belt run is a wall through your own shop. |
| Rotation, and aim assist for it | `rotates: true`, `faceAlong` ([shared/build.js:605](shared/build.js#L605)) | Which way a belt points, the R key, and the ghost — with `rotPinned` already the off switch. |
| **Corners, for nothing** | the same field | A belt hands to whatever it faces, so an east belt feeding a north belt *is* a corner. No corner piece, no turn logic, no second kind. Bends, tees and loops all fall out. |
| A crate that already exists everywhere | `this.deliveries`, `stockCrates()`, `lotStacks` ([shared/lot.js:80](shared/lot.js#L80)) | The whole argument above. |
| One answer for goods hitting the floor | `dropGoods` ([server/sim/index.js:8180](server/sim/index.js#L8180)) | The end of a belt, and CLAUDE.md's flat instruction never to invent a second container. |
| The stocking rule, asked once | `boardFor` ([server/sim/index.js:9737](server/sim/index.js#L9737)), `pourInto` ([server/sim/index.js:9842](server/sim/index.js#L9842)), `shelfAccepts` ([server/sim/index.js:4758](server/sim/index.js#L4758)) | The arm's entire job. `homeKind === shelfKind` is already one rule in three places, and the arm is the fourth asker rather than a new rule. |
| Clutter as a cost rather than a wall | `CLUTTER` = 8 ([server/sim/pathing.js:75](server/sim/pathing.js#L75)), `clutterTiles` ([server/sim/index.js:12672](server/sim/index.js#L12672)) | What a crate standing on a belt already does to pathing — **and it is `shopper ? clutter : null` ([server/sim/pathing.js:104](server/sim/pathing.js#L104)), so a belt run annoys customers and is free to your crew.** That asymmetry is the correct one and nobody has to write it. |
| A drag that sends two ends | `groundStroke` ([shared/build.js:1313](shared/build.js#L1313)), `GROUND_STROKE_MAX` ([shared/build.js:1276](shared/build.js#L1276)), `edgeRun` | The gesture for laying a run, the 4KB cap, and the far-end rule CLAUDE.md has a scar from. |
| A verb done to many fixtures at once | `bulkFixtures` ([server/sim/index.js:10651](server/sim/index.js#L10651)), `holdReflow`, `logFold` | Re-styling, rotating or removing a whole belt run as one press, one re-flow, one line in the feed. |
| A tier ladder that is already a speed | `speed_mult`, `FIXTURE_REFUND`, `downgradeFixture` | Faster belts, faster arms, and the way back down, with no new economy. |
| A part that moves while its fixture works | `motion` in `shared/model.js`, `movingFixtures` in `addFixtureProps` | The belt surface running and the arm swinging. `motion: sweep` is *already* a pose on an authored `pivot` — it is a clock hand, and an inserter arm is the same geometry. |
| The catalog split | kinds are code, pieces are content ([shared/pieces.js](shared/pieces.js)) | Four belt designs, two arm shapes, all as content rows via `create_fixture`, with one ladder and no code. |

Genuinely new: **one field on a crate, one tick pass, and one job loop that does
not walk.**

---

## Where a crate goes, in order

The steps below are the argument each piece was built from, in the order they
were built. This section is the **current answer** in one place, because there
are five kinds and two storeys now and no single file says the whole sentence.
If you are here because a box went somewhere you did not expect, start with this
and then read the step that owns the rung it went wrong on.

Two functions decide everything. `conveyorFlow` says **where a cell hands on**,
once per layout, cached — and `sorterOut` says **which of a junction's ways this
particular box takes**, per crate, per tick. Everything else reads one of those
two, which is what keeps the renderer's picture and the sim's crate the same
shop.

### 1. Which way does this cell hand on? (`conveyorFlow`, `conveyorNext`)

| Kind | Its answer |
|---|---|
| `belt` | Its own `rot`. It is the only kind that is *declared*, and that is why the walk below has a source at all. |
| `under` | Its far mouth if it is an entry, else its own `rot` — see `tunnelExit`. |
| `arm` (loader) | **Derived.** `rot` is the side it *unloads into*, so it cannot also be the pass-through. |
| `sorter` | **Derived** for the straight-on; `rot` is the branch. |
| `lift` | **Derived** for the storey (`way` overrides), and `rot` picks which side it lands on up there. |

Derivation is a **forward walk from the belts**, never a per-cell question: a
loader's neighbours may be loaders, so asking them is circular, and both
cell-by-cell shapes were built and both were wrong (see step 2). At each derived
cell `choose` takes, in order: straight on if the way it came allows it; else a
neighbour that is a *through* (a conveyor on the far side too, which is what
tells a run from a spur); else a plain belt over another loader; else rotation
order; else — **last** — the rise to the other storey.

Then, in order, three passes that only exist because of what cannot be answered
during the walk: **lifts** resolve after it (a shaft fed by a loader has no
answer until that loader has one, and asking during the walk took the server
down once); **leftovers** — cells no belt is upstream of — are resolved and then
propagated from, so a beltless chain does not answer one cell at a time; and a
loader whose `rot` names a shelf, a machine or a skip is a **terminus** unless
there is a duct over it.

### 2. Pairing and spanning

- A **tunnel mouth** pairs with the nearest mouth ahead, same facing, same
  storey, within `TUNNEL_SPAN + 1` — and only if nobody behind it has already
  claimed it (`tunnelClaimed`). Pairing is a matching, not a lookup.
- A **lift** hands to a cell *beside* it on the other deck, never its own
  square. `way` picks the deck, `rot` prefers the side, and both fall back
  rather than pin.
- **Up is a fifth way out** and only two things ever look: a junction told to
  (`riser`), and a loader that has run out of aisle. A plain belt never does,
  or a duct laid across the shop would silently join every run it crossed.

### 3. Which way does THIS box take? (`sorterOut`, junctions only)

Every other cell has exactly one answer. A junction has up to five, and it
decides per crate:

1. **Keen lines only.** A way out is keen if `conveyorServes`/`conveyorMeets`
   walks it forward and finds somewhere *every pile* in the box could be put
   away — `shelfAccepts` for shelving, hopper room for a machine, a skip for
   rubbish and for anything the shop has given up on. There is no filter to
   maintain, so a junction is right about an item authored this afternoon.
2. **Exactly one keen line ⇒ that one**, even if it is jammed. Waiting is what
   every other cell does; re-sorting the box onto a clear line it cannot be put
   away on is worse.
3. **Several keen ⇒ alternate between the clear ones**, remembered per crate
   (`sortChoice`) so the answer cannot flicker tick to tick.
4. **None keen ⇒ the reject side** if one is set, else alternate across the
   whole junction — but never down a line whose only end is a skip, and never
   *eject* while any way out is keen.

Backpressure is asked **after** keenness, never before. A jam on the only line
that wants the goods must not take that line out of the running.

### 3b. Who goes first where two lines MEET? (`mergeHolds`)

The split above is a junction read one way. This is the same T read the other —
two runs into one cell — and it is the half that happens to you without buying
anything, because two aisles feeding one dock is what a second aisle *is*.

Unset (`default`, and every junction ever built) it is `barrier`: whichever box
is nearer the seam goes, ties by id. That is a rule and it is not a *choice* —
it is whichever aisle happens to be running fuller, so the shop's answer changes
with the traffic rather than with anything anybody pressed. `MERGE_ROUTES` is
the player saying it instead: `straight`, `leg`, or `alternate`.

A hold is the whole mechanism and it is one line — the loser stays at the end of
its own run, which is what every cell already does with something in its way. The
half that matters is when it does **not** hold: the favoured line has to be
actually presenting a box bound for this same cell (`presenting`), or a priority
merge is a leg that never moves again the day anything jams a mile upstream.

**It is a fact about the CELL, not about the belt.** The field rides on every
conveyor kind, and it shipped on `belt` alone for a step — a true observation
(a merge needs no piece bought) that was wrong about where merges actually
happen. Which piece stands on the square two runs arrive at is a decision made
for entirely other reasons, and in a real shop that piece is the **sorter**,
because a sorter is what people build where lines meet. So the control was
missing from precisely the junction that backs up, and nothing said so: a sorter
with two feeders and no merge rule is a sorter, and its menu simply had one
heading fewer than the belt beside it.

Two of the four rows are not offered everywhere, and that is `mergeAims`.
`straight` and `leg` are read off `rot` — the feeder directly behind the cell is
the line that does not turn, which is what makes **R** the control here rather
than a compass list in a menu. That only works where `rot` *is* the direction of
travel: on a belt and on a tunnel mouth. A sorter's `rot` is the branch it
favours on the way out, a loader's is the shelf it stocks, a shaft's is the side
it lands on. Answered anyway, the feeder "behind" a sorter is very often the
**leg**, so "let the straight line through" would let the leg through — obeyed to
the tick, doing the opposite of what it reads. So `mergeStraight` is null on
those three, the menu drops the two rows, the setter refuses them, and
`mergeHolds` yields to nobody if a save carries one. Take-turns needs no main
road at all, and it is the one everybody wants at the junction that backs up.

### 4. And where does it leave the network?

Only a **loader** ever hands goods out of a run: `armSwing`'s ladder is units
first (shelving, hopper, skip — all four sides, `rot` only decides which is
tried first), then the rise if there is a duct, then the ground off-ramp capped
at `ARM_DROP_STACK`. A belt, a mouth and a shaft all run *past* a shelf. A run
aimed squarely at the thing it was laid to fill is the commonest wrong build in
the game, and `whatThisCosts` names it by hand for that reason.

### What none of this says

**Whether the line you built reaches anything at all.** Every rung above is a
correct local answer, and a run that serves nothing gives correct local answers
all day. See *What is lacking* at the foot of this document.

---

## Step 1 — the belt

A `belt` row in `FIXTURES` ([shared/build.js:81](shared/build.js#L81)):

```
belt: { label: 'Belt', blocks: false, where: 'indoor', rotates: true, anchor: null }
```

`blocks: false` is not a detail. Every other fixture that carries goods stamps a
tile, and a belt run is thirty tiles — a blocking belt is a wall across your shop
that you drew without meaning to, and `canPlace`'s stranding warning would fire
on every cell of the drag.

### It is a fixture and not a `GROUND` design

The tempting version is the one docs/lanes.md sequences toward: a belt is a
painted cell with a flow direction, riding the lane overlay. It is wrong on four
counts, and the fourth is the one that decides it.

**Ground is one-to-one with `tiles`** (`groundTile` / `groundKindOfTile`,
[shared/build.js:449](shared/build.js#L449)), so a belt cell could not also be
lino — and it walks into the trap CLAUDE.md names about that function, where a
`?? null` meaning "nobody painted here" gains a new answer the day you add a row.

**Ground has no model, no tiers and no variants.** A belt wants all three: it is
a thing you buy, at a price, with a speed ladder, in whatever shape somebody
authors. That is a `fixtures` row and nothing else in this codebase is.

**Ground has no props.** The one thing a belt must do is *visibly run*, and the
moving-part pipeline hangs off `addFixtureProps` and `movingFixtures`. A painted
cell has nowhere to put a moving mesh.

**And ground holds nothing.** `layout.ground` is a sparse list of `{x, z, w, d, k}`.
There is no room in it for a crate, and giving it room is inventing the second
container CLAUDE.md forbids.

A belt is furniture that happens to be flat.

### The tick

> **Rewritten.** What follows is the shape steps 1–3 were built on and it is
> kept because the *rules* it states are still the rules — one crate per cell,
> backpressure, nothing off the end. How they are arrived at is completely
> different, and the argument is in **Step 3b — the line** below. Read that
> before touching `stepBelts`.

One pass, in fixture order, **downstream first** — the last belt in a run moves
before the one feeding it, or a crate skates the whole length of the belt in a
single tick and the belt is a teleporter with an animation on it.

Each belt cell holds at most one crate. Each tick, a belt with a crate on it
offers it to whatever its facing names:

- **another belt** with no crate on it — hand it over
- **an arm's input side** — the arm takes it on the arm's own clock
- **anything else, or a belt that is full** — keep it

That last clause is the whole texture, and it is free: **backpressure.** A belt
that cannot hand on stops, the belt behind it stops, and the arm loading the run
stops because the first cell is occupied. A jammed line is a visible, diagnosable
picture — a row of boxes not moving — which is the single most Factorio thing in
this document and it costs one `if`.

**Nothing falls off the end.** A belt pointed at a wall backs up. The alternative
— spilling to `dropGoods` — is a shop that quietly buries its own floor in boxes
while looking like it is working, and it removes the one feedback signal the
player needs.

### Crates on a belt do not merge and do not stack

`dropGoods` merges a crate of the same thing within a couple of tiles and stacks
a new box on a cell when it cannot. Both are exactly wrong here: a run of belt is
a queue, and a queue whose members merge is a queue that silently destroys the
count. One crate per cell, no merge, no `crateStacked`, and the crate keeps its
own spoilage stamp untouched by the ride.

### Speed is a tier, and it must move a number

`speed_mult` on the rungs, read as ticks-per-cell. CLAUDE.md's flattest warning
applies with force: *a tier that changes no number is a button that takes money
and does nothing*, and `verify:till` exists because three constructors shipped
without a `kind` on their record, so `pieceFor` matched nothing and
`fixtureStats` answered 1/1/1. **A belt's record must carry `kind`** and the
sweep must assert the tier is read.

### The four places a new kind dies quietly

`verify:bin` already wrote these down and every one of them applies:

- `compose`'s `else` is `makeShelf` ([server/layout.js:1100](server/layout.js#L1100)),
  so a belt with no branch is not refused — it is **silently built as shelving**.
- `compose`'s budget map is literal keys against `if (!(budget[p.kind] > 0)) shed(p)`,
  so a kind with no line is dropped and refunded by the re-flow the purchase
  itself triggers. Money back, nothing stolen, and what you see is the shop
  refusing something it had just accepted.
- `FIXTURE_KINDS` ([shared/build.js:428](shared/build.js#L428)) and `budgetOf`
  must stay derived rather than listed.
- `fixtureUnitCost` ([server/sim/index.js:11082](server/sim/index.js#L11082)) —
  price off the catalog row, never a fallback.

### Laying a run

A drag, the way a wall is drawn, capped like `GROUND_STROKE_MAX`, sending **the
pointer's far end** and never the tail of the computed list. CLAUDE.md's scar:
`edgeRun` emits lowest-index-first whichever way you dragged, so reading the far
end back off `segs[segs.length - 1]` builds a run of exactly one for every drag
towards a lower x or z — eight cells of green ghost and one belt, with no refusal
and nothing in the log, and *the screen direction that fails changes as you turn
the camera*, so it reads as flaky rather than as directional.

The drag also sets the facing: the direction of the drag **is** the direction of
the belt, which is the one gesture in the game where that is unambiguous, and it
is why belts want a drag rather than `faceAlong`.

…and it says that about cells **already there**, which for a long time it did
not. A drag steps round an occupied square rather than stopping — a sweep across
a shop clips a shelf — and that skip is about the *kind*: it is not consent to
turn every loader it crosses back into plain belt. It was also, silently,
answering a question about *direction*. So dragging the belt tool back down a run
you had already laid did nothing at all ("nothing could go there"), and the only
way to reverse a line was to knock it out cell by cell and lay it again. A cell
of the **armed kind** is now aimed the way the drag went (`buildRun`, and
`showBeltDrag` draws those squares green so the preview and the press agree);
everything else is stepped round exactly as before. It is free, it is one
re-flow, and it is on the undo stack with the rest of the press. Three lines that
keep it honest: a drag that says nothing new is still an error, a **press** of one
cell is still the swap gesture rather than a turn (the hover ghost comes from
`canPlace`, which refuses a belt on a belt), and the cells keep their **ids** —
a crate's address is a cell id, so a re-aim that went through `placeFixture` or
`repositionFixture` would reverse the run and orphan every box on it.

At the end of step 1 you can lay a loop of belt and watch a crate go round it.
Nothing loads it and nothing takes off it. That is deliberately playable on its
own — it is the step where you find out whether crates-on-belts feels right
before anything depends on it.

---

## Step 2 — the arm

```
arm: { label: 'Arm', blocks: true, where: 'indoor', rotates: true, anchor: 'useAt' }
```

Blocking, because it is a machine and it should cost you the cell. `useAt` so
you can still reach it to empty it by hand when it jams.

**A loader is a belt cell that also talks to what is beside it.** It stands *in*
the run, not next to it.

That is the third shape and the first right one, and the two it replaced are
worth recording because both were arrived at honestly:

1. **Aimed** — takes from behind, gives in front. Lasted an hour of play. A belt
   is a dark rectangle and a machine is a box, so one turned a quarter wrong is
   indistinguishable from one that is working, and the shop just does nothing.
2. **Beside the belt, any side** — works out its own source and sink from the
   belt's direction. Correct, and it cost twice the floor: stocking one row of
   shelving needed a lane of belt *and* a parallel lane of machines, with a
   geometry puzzle at every unit.

Inline, a run is **one row**. Crates flow along it and each loader drops off
whatever the shelf beside it will take; what that unit will not take stays in the
box and rides on to the next one. An aisle is a belt with loaders in it.

So a loader is structurally a belt — non-blocking, stamps `T.BELT`, has a facing,
hands on to whatever it faces, and `beltAt` answers for both — and does two extra
things per swing:

| | |
|---|---|
| **Unload sideways** | pour into any adjacent unit of shelving, through `pourInto` |
| **Pick up** | if empty, lift a crate off the floor beside it |

That second one is what gets goods out of the yard without a second kind of
machine, and it is why there is no separate "loader" and "unloader".

Its own facing decides only where a crate goes **next**. It unloads to all four
neighbours regardless, which is why the art has no direction in it — see the
turntable, and the three attempts before it.

### It must not become the 14th spelling of the kind rule

`holds(kind, item)` exists at [shared/tags.js:306](shared/tags.js#L306), is
documented as everybody's rule, and is currently called by **one test and nothing
else** — every one of the thirteen production sites writes
`homeKind(x) === shelfKind(y)` out by hand. That is the exact failure `verify:hot`
was written for, already halfway back. The arm calls `pourInto`, which asks
`boardFor`, which asks the rule once. It adds no spelling of its own.

### Probe pure, commit through the funnel

`boardFor` is **not a predicate** — it calls `openStack`, which pushes a real,
priced, zero-qty board onto `shelf.stacks`. Four job sites already use it as a
yes/no and throw the answer away, and each of those probes consumes a board slot
and divides `shelfCapacity` for everything else on the unit until the next day
roll. An arm ticking many times a minute would do that continuously.

So: **probe with `shelfAccepts`
([server/sim/index.js:4758](server/sim/index.js#L4758)), commit with `pourInto`.**
That pair is the whole of the arm's stocking code, and it is the same rule a hire
obeys at the moment of the press, by construction rather than by agreement.

### It has a clock, and the clock is the throughput

Ticks per swing, off `speed_mult`. This is where the items-per-second thinking
that crates took away comes back: a belt delivers boxes and an arm empties them
at a rate, so a shelf fed by one slow arm is a bottleneck you can see, standing
next to a belt that has backed up behind it. Buy a faster arm or buy a second
one — which is a ratio, arrived at by looking.

### What it does when it cannot

The same thing the belt does: nothing, and visibly. A crate whose contents no
board will take sits on the belt in front of a stationary arm. **It must never
divert, never spill, and never pick a different shelf** — an arm that quietly
finds somewhere else to put things is the spread bug with no hire to blame, and
CLAUDE.md's `homeFull` note is the record of how that one goes.

At the end of step 2 a belt run from the bay to an arm at the end of an aisle
stocks a shelf with nobody walking. That is the feature. Steps 1 and 3 are
scaffolding around this one.

### Step 2b — who is allowed to put something ON one

Steps 1 and 2 built a conveyor that nothing could load except a loader with a
crate lying next to it. Three things were missing, and all three are the same
sentence: **a belt is only worth laying if the things that move goods know it is
there.**

**You.** A conveyor cell is a square, and a square is somewhere goods go down —
so `dropCarry` and `dropCrate` both post onto one, at the same reach, with the
same green square and the same ring. `beltPut` is the verb rather than
`dropGoods`, for `dropGoods`' own `!d.belt` reason turned around: it merges with
a box within a couple of tiles and stacks a second one on the cell when it
cannot, and a run of belt is a QUEUE. One crate per cell. What that costs is the
one place in the game where a square that already has a crate on it is a
**refusal** — so `canDropAt` has to rule it out too, or the ghost is green over a
press the server turns down.

**The crew, positively.** `unload`'s haul branch asks `beltFor` before it asks
`shelvesFor`, and it is deliberately not a comparison of the two walks: the point
is not that the belt is nearer, it is that the rest of the journey costs nothing.
`wholeCrate` gains the same clause, because every one of its size tests weighs
two JOURNEYS against each other — "at or under an armful the box is pure
ceremony" is true of two walks and false the moment one of them is a belt. Leave
it out and the branch is unreachable for exactly the shop that laid a conveyor to
fix it: a bay of part-crates, with the crew making armful trips down an aisle
that has a belt running along it.

**The crew, negatively — and this is the one that would have broken it.**
`stockCrates` keeps the whole list on purpose (`homeSupply` counts a riding box
as supply, `binOrphans` sweeps it, spoilage ages it) and a hire is the one reader
for which that is wrong: a box off a pad scores as a **stray**, which is a 1e6
bonus in `unload`'s own ranking. Unfiltered, every stocker in the shop abandons
the bay and beelines for whatever is going past — the conveyor works perfectly
and is emptied by the crew it exists to replace. `floorCrates()` is the one
spelling, and the five job sites that LIFT ask it.

And one thing that was simply wrong: a loader poured into the first side that
took something and stopped. `rot` is the side it asks *first*, so the shape it
was drawing was "one shelf fills, its neighbour stays bare with a loader touching
it" — which reads as the loader being aimed wrong. A swing now serves every side
it can, and the art draws a shaft per side rather than per loader.

### …and loops, which is what people actually build

Two bugs came out of the first real ring somebody laid, and both draw identically
to a working belt.

**Flow had to stop being a per-cell question.** A loader's `rot` is the shelf, so
its output is derived — and it cannot be derived one cell at a time, because its
neighbours may be loaders whose answers are also derived. Refusing to ask them
(steps 1–2) is right for a loader with a belt on either side and wrong for a run
made of loaders, which is what an aisle becomes: nobody has a feeder, nobody
carries straight on, and the run bends wherever rotation order points. Asking
recursively is worse — "unknown" reads as "open", so a straight run resolves
backwards from the far end and the two halves meet in the middle. `conveyorFlow`
resolves the whole layout at once by walking FORWARD from the plain belts, which
are the cells that know their own direction. The rule that falls out and is worth
saying to a player: **belts on the corners, loaders down the straights.**

**A jammed box must drop its charge rather than hold it.** Holding it at the brim
means the box moves again the tick the way clears — and since the *travel* is
drawn on the cell you land on, a crate blocked every time it lands never plays
one. Three crates on a loop, one smooth. A cleared jam costs one cell-time per
box now, which is what a conveyor draining looks like. *(Retired by step 3b:
there is no charge, and a jam clears from the front at the speed of the belt
because the clamp lets go. The bug it names is the reason the rewrite happened.)*

### What `rot` means on a loader now: three answers, decided by what is there

Flow is derived, so for two steps `rot` was only "the shelf it tries first" and a
loader had no aimable output at all. It has three meanings now, and which one
applies is read off the tile it faces rather than chosen:

| It faces | It does |
|---|---|
| shelving | stocks that unit first, and every other side after it; flow stays derived |
| **a conveyor** | that IS its output — it feeds that line rather than joining its flow |
| bare ground | sets down there whatever no unit took (below) |

The middle row is the one that was missing. A loader taking goods off a shelf and
injecting into a loop running past it is an ordinary thing to build and no
rotation would do it. It is never allowed onto its own feeder — a belt already
resolved as pointing at the loader is skipped — because that pair is a two-cell
tug of war, which is a run that dead-ends in the middle of itself and draws
exactly like a working one.

### The off-ramp, which is the one thing `rot` decides on its own

A belt had exactly one exit: a board that will take the goods. So a crate holding
anything no unit on the run wants rides for ever — round a loop, or parked at a
dead end where nothing can reach it, since the crew are told to leave a riding
box alone. Three frozen pizzas on a run with no freezer on it is a permanent
passenger, and the shop looks like it is working the whole time.

A loader that **faces bare ground sets the rest of the box down on it**, through
`dropGoods` like every other setdown in the game. Aim it at shelving and it
stocks; aim it at a floor tile, a pad or a stockroom and it unloads there. That
is also the answer to "I do not get to control the loader" — every other side of
it is derived, and this is the one that is yours.

Three things keep it from being a shop that buries its own floor. It is reached
**only after every unit beside it has had its share**, so a loader bolted to a
shelf never prefers the ground. The mat **stacks to `ARM_DROP_STACK`** (3) and
then stops, which is the same backpressure the run has — uncapped it is a tower
for the rest of the save, and a mat of one is a stockroom that holds a single
box. And the pickup side **skips the faced tile**: three sides in, one side out,
or the off-ramp is a loop that sets a box down and lifts it straight back up.

### …and a pad is consent, which is why the box must not TELEPORT

A pad outranks the faced tile — painted ground that means *goods go here* is
permission already given, so aiming a loader at your own yard is asking for it
twice. What that inherited from `stow` is the pad as a **region**, and there the
two callers part company. You walked to the pad, so the pad is where you are; a
machine is at one cell. A pad has never had to be one shape — the brush paints
cells — so a lone storage square painted at the end of an aisle is the same named
region as the yard by the back door, and `dropGoods` fills a region *by list
order*. A live shop had a loader set a box down beside its fridges and the box
appear thirty tiles away at the bay, merged into an unrelated crate.

That is not a slow delivery or a wrong shelf. It is a crate crossing the shop
instantly, and **it reads as goods having been destroyed**, because the place you
were watching is empty afterwards and nothing anywhere says otherwise. The
report it arrives as is "the crate disappeared".

`padIsland` is the fix: the cells reachable from the touched one by ordinary
four-way adjacency. Two things about it. It is **four-way and not eight**,
because two cells touching at a corner are two places to everything else in this
game that walks. And the same island bounds the **`byArm` mark** — the guard that
stops a loader lifting back what it just set down. Marked over the whole region
that guard is switched-off for the loader that needs it most: a bay is where the
crates already are, so a loader bolted to one would refuse every delivery the
shop ever takes. It marks the boxes the drop **landed in**, which is the only
thing it was ever about.

Not done, and it is the obvious next thing: **the shop does not yet buy or pack
FOR a line.** `restock` and `pickItem` know nothing about conveyors, so the
ordering fills a belt-served shelf exactly as it fills any other, and `packCrate`
builds boxes by what is on the pad rather than by what is down the run. That is
where step 3's pure-crate rule earns its keep, and it should be built with the
sorter rather than before it.

---

## Step 3 — the sorter, and it sorts by DESTINATION

**Built, and not the way this section proposed.** The argument below is kept
because the trap it names is still live; what changed is the filter.

A belt with two outputs: straight on, derived from the run exactly as a loader's
is, and a BRANCH, which is its `rot` — the same inversion `arm` made and for the
same reason. A sorter's straight-on is the boring half; the side you want it to
divert down is the half you have an opinion about, so that is the one R sets.

### There is no filter, and that is the change

The proposal was a tag on the fixture: `frozen` down one branch, `produce` down
the other. Authorable, predictable — and a thing you have to *maintain*. Every
item you add is a filter you have to remember to widen, and a filter that has
fallen behind your catalogue is a line that has quietly stopped carrying half
your stock, which looks exactly like a line that is working.

The run already knows what is down it (`conveyorServes`, which walks both ways
out of every junction it meets) and the shop already has one rule for whether a
unit will take something (`shelfAccepts`). A sorter asks those two. It is right
about an item authored this afternoon, there is nothing to keep up to date, and
it adds no fourteenth spelling of the kind rule.

### …and with no answer it SPLITS, which is the other piece people wanted

Both sides would take it, neither would, or the box is mixed — then it alternates.
That is a splitter, it balances two lines, and it is the same piece. `auto: false`
pins it there: a junction you have switched the thinking off on is still a
junction, and "does nothing" would be the wrong thing for it to become.

…and the split is between the lines that **want** it, not across the junction at
large. That distinction does not exist at a two-way sorter, which is why it took
a real shop to find: with three ways out, one of them is an exit that serves
nothing — a spur to the yard, a line still being built, a column with no loader
on it yet — and such a line is never keen, so it can never win the single-keen
test and used to draw its full share of the alternation regardless. Measured at
**4 boxes in 12** down a dead line in a junction with two good ones. Every box
that arrived was correct, so what it reads as is a sorter that works
intermittently, which cannot be told from one that is guessing — and it gets
worse the more of the shop you automate, because each line you add is another
slot for goods that had somewhere to be. Nothing keen still splits across
everything: a box no line wants has no better claim on one exit than another.

### Which half of its job a loader does

One machine that both lifts and pours is why there is no separate loader and
unloader in this game, and it is what makes a run work with nothing configured.
What it cannot do is stand between a pad and a line. `armDrop` prefers painted
ground over everything — consent already given, said once, about that square — so
a loader with a yard on one side and no shelving beside it lifts a box off that
yard and puts it straight back on it. The run it was bought to feed never gets
anything, and every frame of it is a machine doing its job.

`mode` is `both` on every loader ever built. `load` is a belt cell that also
lifts — it never pours, never off-ramps and never bins, so the only way off it is
the run. `unload` is the mirror, and it is what stops a stockroom or a pad beside
a line swallowing everything going past.

The pair is deliberately not one boolean. "Does it lift" and "does it put down"
are two questions, and a shop wants each of them answered alone: the loader on
the yard is `load`, the loader at the end of an aisle is `unload`, and the one in
the middle of a run beside two chillers is `both`.

### …and the line for what nothing wants

Splitting a stray across every way out scatters it, and each share then rides to
the end of a line that was never going to take it. Almost every real junction has
a way out that is not a destination — the spur back to the yard, the loop past
the skip, the column that has not grown a loader yet — and the sentence the
player wants is *if nobody wants it, send it that way.* There was nowhere to say
it.

`reject` is a quarter turn on the sorter, `null` on every one ever built. Four
things about it. It is a **turn and not a cell**, for `rot`'s own reason: the run
next door is rebuilt and re-minted on every re-flow, so a stored neighbour goes
stale the first time you extend the line. It fires **only when nothing is keen** —
a reject line that could outrank a line which *will* take the goods is not a
reject line, it is a leak, and it is `homeFull`'s spread bug with a switch on it.
The reject side is **excluded from wanting things**, or a spur that happens to
pass a shelf quietly becomes an ordinary destination and takes its share of the
sorting. And it is skipped when **jammed**, or one stuck box downstream stops the
junction dead.

It is a **separate field from `rot`** because they are opposite questions: `rot`
is the branch you aimed at, a preference among the lines that do want things, and
the line you want strays down is very often the one you did not aim at. The menu
says "the way it points" rather than naming a compass side, because the junction
is aimed and you are looking at it.

### …and a reject side is a PLACE, not only a line

A reject line was a line, and for a while that was the whole of what it could be.
Both the branch test and the reject test ask `beltAt`, so a junction aimed at a
pad or at bare floor had a side the piece **could not see at all** — not refused
and not warned, invisible. The press was accepted, the field was stored, and the
box went down the trunk anyway. Nothing anywhere disagreed with the player.

That is the shape this file keeps recording, and it is worse here than most,
because the sentence somebody is trying to say is one the junction **has already
worked out**: `keenAny` is exactly *does anything down any of these lines want
this box*. It computed the right answer twenty times a second and then had
nowhere to put the box. A real shop's junction sits next to the yard far more
often than it sits next to a spare spur.

So `sorterEject` is the other half of `reject`: a conveyor on that side hands on
as it always did, and a **pad or walkable floor** takes the box off the run
through `armDrop` — the loader's own off-ramp, already island-aware, already
capped at `ARM_DROP_STACK`, already marking `byArm`. Four things about it.

**A loader cannot stand in for this, and that is the whole argument for putting
it on the sorter.** A loader offers the box to whatever is beside *it* and
off-ramps the remainder, so it has no way to ask what is further down the run.
One stood on a junction with no shelving next to it dumps *every* box that
passes and the line dies. Only the piece that chooses between lines can know that
nobody wanted it.

**The keen test is `sorterOut`'s own**, extracted to `sorterWants` rather than
copied. A junction that chose a line by one rule and ejected by another would
eject boxes it had just decided somebody wanted — the same drift CLAUDE.md
records between the shop's rule and the hand's.

**It asks every way out, not the clear ones**, which is the one place this parts
company with the reject *line* above. A jam is a reason to wait and `stepBelts`
already waits; a drop is a hire's walk to undo. Ejecting stock because an aisle
was briefly busy hands the automation quietly back to the crew.

**A full pad carries on down the line** rather than jamming the junction, which
is the same call the reject line makes about a spur that has backed up. And the
ejection is **charged a cell-time**, or the box vanishes the tick it lands while
every other box on the run glides — the jam-at-the-brim bug wearing an off-ramp.

The alternation is a counter rather than a draw, because every balance number in
this game is downstream of how many times `this.rng` has been called. And the
decision is made **once, when the box arrives**, and remembered until it leaves:
`sorterOut` is asked every tick — the backpressure test needs to know which cell
to look at — so an answer recomputed each time would flip twenty times a second
and the box would leave by whichever side the tick it was ready happened to land
on, which is a coin toss wearing a rule.

### The pure-crate rule survives intact

It only ever diverts a crate **every pile of which** wants the branch.

The problem a crate brings, and it has to be answered rather than avoided: **a
crate holds several piles.** A box of carrots and eggs has no correct
direction.

Three answers, and only one of them survives:

- **Sort on `lotMain`** — the biggest pile. This is precisely the mistake
  CLAUDE.md records about the chevrons: `takers` took `lotMain` and hands holding
  bread and ice cream lit the shelves for the bread and no freezer at all. A rule
  that answers for one pile and acts on all of them is the green-ghost bug wearing
  a filter.
- **Split the crate** — take the matching piles out into a new box. Expensive,
  creates crates on a hot path, and doubles the number of boxes on your belts,
  which is a jam rather than a feature.
- **Divert only a crate whose every pile matches.** Predictable, splits nothing,
  and answerable by looking at the box.

The third, and the sentence to put on the fixture: **a sorter only diverts a pure
crate; a mixed one goes straight on.**

That is not a limitation dressed up. It makes the `packs` rung — which builds
single-kind crates out of a bay of part ones — into the thing you buy *so that
your sorters work*, which is a dependency between two features that were designed
years apart and a genuinely Factorio-shaped one: you need a purity step upstream
before sorting means anything.

### `verify:belts`

Everything in steps 1–3 is invisible in a still frame by construction — a crate
that rode a belt and a crate a hire carried are the same box on the same shelf,
and the shop is the same shop afterwards either way. Only the wage bill moved. So
this ships **with** the feature, the way `verify:doors`, `verify:park`,
`verify:price` and `verify:routes` did.

- **A shop with no belts is the old game to the cent.** The control that decides
  whether any of this is opt-in. Paths, takings and stock bit-identical across
  generated layouts.
- **Conservation, at all three hops.** Nothing created or destroyed belt-to-belt,
  through an arm, or across a sorter. Every new place goods can move between in
  this game has been a hole.
- **A spoilage stamp survives every hop.** `verify:pack`'s centrepiece pointed at
  a belt: a merge keeps the *destination's* stamp, and a kind arriving as a bare
  `{item_id, qty}` with no stamp is read as fresh for ever
  ([shared/lot.js:155](shared/lot.js#L155)). Either one makes a belt the way to
  beat rot, and a crate of laundered flour looks exactly like a crate of flour.
  Read through `lotStacks`, write through `.stacks`.
- **Backpressure.** A run pointed at a wall backs up and *stops*; it does not
  spill, duplicate, or drop the last crate. The downstream-first ordering is
  asserted directly, or a crate crosses the shop in one tick.
- **A belt is clutter, not a wall.** A hire can still reach the break area across
  a belt run, however badly it is drawn. This is `verify:break`'s `TIRED_PACE`
  pin arriving through a new door, which is the third time that has happened.
- **An arm obeys the shop's rule, not its own.** The nine-way `STOCK_KINDS`
  matrix walked at an arm rather than at a hire — the fourth asker giving the same
  answers as the other three.
- **An arm never feeds a given-up board**, asserted against a control board the
  shop has not given up on. This is the one judgement rule it takes and the
  assertion is what stops it being `merchandise`'s round trip with no hire in it.
- **…and it is exempt from the other three**, which is the other half of the same
  claim and is otherwise unprovable: an arm bolted to a unit that is not the
  item's `homeShelves` home, and to one with `managed: false`, must still fill
  both. Written as a value each way, because "obeys everything" passes every
  assertion above it.
- **A thousand idle ticks open no boards.** `boardFor` mutates — it calls
  `openStack`, which pushes a real priced board — so an arm that probed with it
  would consume a board slot per tick and quietly divide `shelfCapacity` for
  everything else on the unit. Tick an arm against a shelf it can never fill and
  assert `shelf.stacks` is byte-identical afterwards.
- **A sorter diverts a pure crate and passes a mixed one**, asserted against a
  mixed control, because nearly every way of getting a filter wrong moves too
  much rather than too little.
- **A load-only loader never puts a box back on the pad it lifted from**, with
  `both` as the control doing exactly that round trip — the switch has to change
  something or it is a change to every save instead. Paired with the mirror: an
  unload-only one lifts nothing. Plus survival across a re-flow AND across a
  ROTATION, which is the press that actually happens: `repositionFixture` builds
  a fresh placement naming each field it keeps, so a setting left out is not
  un-copied but RESET, by the re-flow that same call triggers. Aiming a loader
  at the line you want handed the machine its pickup back at the exact moment
  you were setting it up. Asserted of a sorter's `auto` too, which had the hole
  from the day it shipped. And that the version MOVES on a mode change: the
  chevrons and chutes it decides live in `staticRoot`, which the client rebuilds
  only when that number changes, so without a bump the switch works in the sim
  while the picture keeps showing the old one — a switch that looks like it did
  nothing, which is worse than one that does nothing.
- **A reject line takes only what nothing wants**, against the control that
  every sorter is built without one. Paired with the claim that costs a shop: a
  box a line WOULD have shelved is never rejected — "sends strays away" passes
  on a sorter that sends everything away. Plus that it survives a re-flow, since
  build mode re-flows on every wall segment of a drag.
- **…and a reject side that is GROUND takes the box off the run**, which is the
  half that was invisible rather than wrong: aimed at a pad or bare floor, the
  press was accepted and nothing happened. Its control is the same one — a
  sorter with no reject never ejects anything, however unwanted — and its leak
  case is the same too, because an ejector that fires whenever it is asked
  passes "strays come off" while quietly emptying the run onto the floor. Plus
  that a conveyor on that side still HANDS ON rather than setting down (two
  crates on one cell otherwise), conservation across the ejection, and survival
  of a re-flow. What it cannot assert is the thing that makes it belong on the
  sorter at all: a loader in the same square dumps everything, because it can
  only ask what is beside it.
- **A split goes to the lines that want it**, asserted at a junction with THREE
  ways out — the claim does not exist below three, which is why two-way coverage
  never caught it. Paired with "both good lines are still shared", or narrowing
  the pool to one winner passes the first half while turning the splitter off.
- **An off-ramped box lands on the pad cell the loader is TOUCHING.** Written as
  a pair and worthless split in half: it has to arrive on the near island *and*
  nothing may turn up on the far one, because a sweep that only counted
  crates-on-the-pad is satisfied by the teleport. The one assertion in this file
  written to a bug reported from a screenshot — "see that crate? it disappeared."
- **A re-flow does not restart a belt.** `verify:park`'s claim about the car:
  building re-flows on every wall segment, so a crate that began its ride again
  each time never arrives. A crate mid-belt is *parked*, not reset.
- **`homeSupply` counts a crate on a belt.** Or the shop buys a second van-load
  of what is already thirty seconds from the shelf — which presents as the
  ordering being broken, days downstream of laying a belt.
- **Ids do not collide.** `fx-N` against the generator's namespace, or a re-flow
  hands a belt somebody else's crate.

---

## Step 3b — the line, which is what the unit should have been all along

**Built.** Nothing a player can measure changed: one crate per cell, the same
backpressure, the same sorter rules, the same loaders, the same spurs, the same
speeds. What changed is what the code is made of, and it is the only entry in
this document written to a class of bug rather than to a feature.

### The complaint

Crates skipped at a T junction. Crates did not tween through a turn. Crates
appeared at the end of a segment. A crate reset to the start of its cell when a
jam cleared. Four reports, four fixes, and each fix exposed the next one.

They were one bug. **The unit was the TILE.** Every conveyor cell owned at most
one crate, its own clock (`beltClock`), its own reservation of the cell in front
(`beltAim`) and its own answer to where that crate went next; the drawn position
was a per-cell tween off that clock. So the code where two cells meet was a
**seam**, and a seam is a place two correct rules have to agree:

- a blocked crate had to creep forward to sit behind the box in front, bounded
  by its own leading edge, and the creep had to be banked into the clock or the
  crate was re-drawn at its own centre the tick the way cleared;
- a corner had to be a special case, because the tween's direction came off the
  pair of cells rather than off a path;
- a junction asked a different question when its exits were full than when they
  were free, and the answer had to be remembered or it flickered twenty times a
  second;
- and the position of a crate was assigned in five branches — moving, blocked,
  arriving, on a spur, held at an eject — each right on its own.

A junction is where a crate changes which of those branches it is in, which is
why a junction is where every one of them was reported.

### The shape

[Factorio's](https://www.factorio.com/blog/post/fff-176), for its reason: **the
unit is the transport line.**

- A **line** (`conveyorLines`, [shared/build.js](shared/build.js)) is a maximal
  chain of conveyor cells with an ordered path and a length in tiles. One
  object.
- A crate on a line has **one piece of state**: how far along it has got.
- Each tick the crate at the **head** advances if the line's exit will take it,
  and every crate behind is clamped to at least `CRATE_PITCH` behind the one in
  front. That clamp **is** backpressure, **is** the compaction a jam draws, and
  **is** the one-crate-per-cell rule, because the pitch is a cell.
- Position is **derived** by walking the path (`alongPath`), in one function.

Corners fall out because the path bends. There is no corner code, no creep, no
per-cell clock, no reservation and no junction special case, and deleting all
five is the test that the rewrite actually happened rather than being painted
over.

### Where a line ends — three answers, and one deliberate non-answer

A **junction** is a line of its own. A sorter chooses between ways out, so it
cannot be a link in a chain that has already decided where it goes: it breaks
lines apart rather than participating in one.

A **merge** starts one. Two lines feeding one cell need somebody told no, and
the only place that can be said once is the cell they are both aiming at.

A **terminus** ends one, which is a cell handing to nothing.

**A loader is none of those, and that is the load-bearing call.** The obvious
reading is that the machines are the endpoints — and it is wrong here, because
this game's loaders stand *in* the run ("belts on the corners, loaders down the
straights"). Break at them and an aisle stocked by six is six lines of one cell
each, which is the per-cell shape back with a new spelling, in exactly the shop
this whole feature exists for. What a loader does to a crate is hold it and send
it sideways, and neither of those is a question about which way the line goes.

### The four things that are not obvious

**The seam has to OVERLAP.** A line's path runs to the *first cell of the next
line*, not to its own last cell, so the point a crate is handed on at is a point
both lines agree about and the box does not move a millimetre when it changes
hands. Ending a line at its own last cell would put a one-tile jump at every
join — which is the skip, rebuilt.

**The address is a CELL and the model is a line.** A crate stores `d.belt` (the
cell) and `d.off` (how far past its centre), and the distance along the line is
computed from those. Storing the distance instead would be simpler and would go
stale the first time anybody re-cut the lines: extend a run upstream and every
box on it is suddenly measured from somewhere else. A cell id is a fact about
the shop that survives a re-flow, is already saved, is already what the renderer
files a box by, and is already swept when the cell is demolished.

**The reservation is a NEGATIVE distance rather than a map.** `beltAim` existed
so two cells could not both hand into a third. The line version is that a crate
which has left its own line's last cell but not yet arrived is counted at a
negative distance along the line it is heading for, so anything else feeding
that line sees it coming. Nothing is stored, so nothing can be left standing
when a crate is eaten by a shelf half way through a hand-off — which is the
failure a stored reservation has and this one cannot.

**...and a crate must not count ITSELF.** A ring is a line that feeds itself, so
a box part way round the join would see its own committed hand-off as something
in its way and stop dead on the seam for ever, waiting for itself. It is the one
case in the whole thing where the obvious code is silently a deadlock, and it
draws as a conveyor that works until you close the loop.

### A spur is a line too

A loader's spur was the last special case and it is folded in: the path is
`[machine, unit, machine]` — out, and back if the unit would not take everything
— with one number saying how far along it the box has got, walked by the same
`alongPath` the run is. There is no direction to get wrong at the turn and
nothing to re-place when it happens. A lift is the same path with the near end
dropped. The goods still change hands **on arrival**, which is the property the
spur was built for.

### What `verify:belts` claims now

Section 15 was a claim about `BELT_CREEP_MAX` — a blocked crate creeping up
behind the box in front, bounded by its own leading edge — and that is a claim
about an implementation that no longer exists. It is now the continuity claim,
which is what a player was actually reporting: over a straight run, a bend and a
junction, each with the jam that used to break it, **nothing goes backwards
along the path and nothing steps further than one tick of travel**, asserted
every tick. Plus the capacity half, which is the thing the pitch decides: two
queued boxes sit squarely on two different cells exactly one pitch apart.

---

## Step 4 — machine feeds machine

**Built.** A loader beside an appliance puts ingredients into its hopper and
lifts finished batches off its tray, so a chain of appliances runs with nobody
walking. It is two verbs on the swing that already existed, and neither is a new
rule — which is why it cost so little and why it was three quarters done for two
steps without anybody noticing the last quarter was missing.

### The two halves, and the one that was missing

`armFeed` has filled hoppers since step 2: `armLand` offers the box to shelving
first (`armPour`) and to a machine second, so a loader touching both stocks the
shelf and tops up the hopper with what is left. That half was never the problem.

Nothing could take the product **out**. Every chain therefore stopped at the
first appliance and waited for a person — and it reads as the kitchen not being
automatable, when it was three quarters of the way there. `armTake`
([server/sim/index.js:11981](server/sim/index.js#L11981)) is the other half: one
tray, one swing, straight onto the run.

### Where it sits in the swing, and why that is not arbitrary

`armTake` is swing **step 3**, ahead of the stockroom pull. A full tray *stops
its machine* — `stationTrayRoom` is zero while something is sitting in it, so the
next batch cannot start — where a stockroom is perfectly content holding stock.
So this is the swing that **unblocks** something and that one is the swing that
tidies, and a loader that did them the other way round would leave an oven cold
while it filed boxes in a back room.

### It takes no destination test, and that is the difference from `armPull`

`armPull` refuses to lift a board nothing downstream wants, or a loader shuffles
boxes round your shop for ever. `armTake` deliberately does not ask, and the
asymmetry is the tray/stockroom one again: **a tray is not storage.** Emptying it
is the entire point, and a box nothing wants is what the off-ramp
(`armDrop`, `ARM_DROP_STACK`) is already for. Give this one a destination test
and a machine with no taker downstream simply stops, which is a jam nobody drew.

### The four things that are not obvious

**One slot per swing.** A twin machine's two heads finish at their own times, so
each tray is a separate lift rather than one sweep — the mirror of
`collectStation` taking both, and for the opposite reason: a hire has two hands
and a loader has one box.

**The stamp rides** (`day: out.day ?? this.day`). `verify:pack`'s centrepiece
pointed at a kitchen: a batch arriving with no spoilage stamp is read as fresh
for ever, and cooking would become the way to beat rot. A crate of laundered
bread looks exactly like a crate of bread.

**A deleted item is skipped**, not lifted — `c.byId.items[out.item_id]`, the same
forgiveness every stock loop in the game shows and the reason `binOrphans`
exists. Content is edited live and a recipe's output can stop existing while a
tray holds four of it.

**The probe is `armTakes`, and it is arithmetic rather than a fourth opinion.**
The hopper's version of `shelfAccepts` is `stationHopperRoom > 0` against the
union of the slots' inputs, read without moving anything, because the spur is
chosen before the journey and the goods change hands at the end of it. Same
probe-pure/commit-through-the-funnel pairing step 2 argues for, said about a
machine.

### What falls out for free, and what does not

**Ratios.** Two mixers per oven, because the batch times say so, with no new
mechanic at all. That was the whole pitch and it holds.

**And nothing exercises it.** This is worth writing down, because the mechanism
being finished is not the feature being playable. Intersect every recipe's
outputs with every recipe's inputs and the answer is **the empty set** — all 24
recipes are one hop, raw goods in, finished product out, and not one of them eats
another's output. So there has never been a reason to lay a belt between two
machines, and this step is a spine with nothing on it. Eighteen of the
twenty-four distinct inputs are van-only besides, so *making your own goods* is
not merely undone, it is unreachable.

The fix is content and not code — one three-deep chain authored through
`create_item` / `create_recipe` is enough to find out whether a belt between two
machines is fun. Until somebody authors one, **step 4 is unplayed rather than
untested**, and `simulate` cannot help: the balance bot never runs an appliance,
so a kitchen economy measures as no change over ten seeds. That is the instrument
being blind, not the change being free.

---

## Step 4b — the farm, which is the walk that never changes shape

The open question at the bottom of this file used to be *can a belt go
outdoors*, with "the farm is the obvious second customer" as the reason to
care. Belts became `where: 'any'` in step 2, so they could reach the field —
and the last link was still missing: **a loader could not collect anything.**
`conveyorMeets` knew shelves, stations and bins, which is three things a loader
puts goods *into*, and the farm is the only place in the shop that produces
them.

So a run laid out to the beds did nothing until a hire walked out, collected by
hand, and set a crate down beside it. The belt was the second half of a journey
whose first half was the whole walk.

`armGather` (a pen) and `armReap` (a bed) are that link, and both are
`armTake`'s shape — the verb that lifts a finished tray off a machine. **That
parallel is the argument for where they sit in the swing**: a full tray stops
its machine, a full pen stops filling, and a ripe bed cannot grow the next
thing. All three are swings that *unblock* something, where the stockroom pull
below them is a swing that *tidies*. The pen goes before the bed for `farm`'s
own reason (see [docs/pens.md](pens.md)): a full pen has **stopped** where a
ripe bed merely sits there.

Four things about it are worth knowing.

**They are the only entries in `conveyorMeets` a loader takes goods OUT of.**
A pen and a bed produce, so there is nothing to fill them with. Which also
means the placement warning had to change its wording: `works` used to say
"nothing beside it to **fill**", and a loader against a pen is doing the
opposite — a warning that names the wrong direction sends you to the wrong side.

**A pen is 2×2, so `covers` and never `x === x`.** A pen's record is its *min
corner*, so three of its four sides are not its `x, z` — a loader against any of
them would have found nothing there. That is the `fixtureAt` trap docs/pens.md
lists among the eight places "a fixture is a tile" was load-bearing, arriving on
a conveyor, and it is the worst shape of it: half the placements work perfectly
and the other half quietly do nothing, with nothing on screen saying which one
you built. `verify:belts` 22c builds all four corners.

**The pen's clock is reset, not just its `qty`.** `stepPens` pins `filledAt` to
now on every tick a pen stands full, so the two agree without either knowing
about the other — and a collect that left the stamp alone would hand the next
batch over the instant the gate cleared. That is "a pen is not a hopper" undone
by a machine, and it is invisible: a pen that refilled early and one that
refilled on time are the same full pen.

**`armReap` buys the seed, exactly as a hire does.** This looks like the thing
docs/workers.md forbids — *what something is worth is the player's question, and
a worker answering it is a worker spending your money* — and it is not. The line
is **who chose**: you sowed that bed, and re-sowing what is already in it is
carrying out your decision rather than making one. `harvest` has spent a seed on
every pick since auto-replant shipped, so one rule or the crew and the conveyor
undo each other down the same row — and a machine that skipped it would leave a
field of rough soil behind something that looked like it was working.
`replantable` already refuses on season and on cash, so neither can go negative.

There is **no destination test**, unlike `armPull`. That one takes stock the shop
has already placed and could strip an aisle onto a run with nowhere for it to go;
these create goods that did not exist a tick ago, and the off-ramp (`armDrop`) is
what guarantees they land somewhere.

### A run goes AROUND a field

A belt still cannot be laid on a paddock or on a bed. `T.PADDOCK` is a pad and
`T.PLOT` is what a bed is made of, and neither is in `BUILDABLE_INDOOR` or
`BUILDABLE_OUTDOOR` — the same rule that keeps a run off the delivery bay and
the car park. That is deliberate rather than an oversight: a conveyor through
the middle of a field is a conveyor through the middle of the thing it is
collecting from. Lay the run alongside and let a loader reach in, which is the
sentence step 1 already wrote about pads.

---

## Step 7 — the tunnel, and the tile it does NOT own

Built, as the `under` kind — the section below is the argument it was built
from, and the one thing it renamed is the kind: `belt-under` became `under`,
since `deck` proved a kind does not have to be spelled out of its neighbours.
`verify:belts` covers it.

It came out of play rather than out of this document: a return leg costs as much
floor as the leg it returns from, a run cannot cross its own outbound line at
all, and a conveyor laid through the shop reads as back-of-house in a room full
of customers.

**The bridge is the wrong answer and is worth saying once.** A belt is
`blocks: false` — that is step 1's rule and the reason a run is not a wall
through your own shop — so shoppers already walk over one. A walkway would buy
permission that has never been withheld. What is actually scarce is the SQUARE:
two runs cannot share it, and the one they are fighting over is the one the
shop floor wants back.

### The shape

One kind, `under`, laid twice: the first press is the mouth going down,
the second within range is the mouth coming up, and the pair is matched the way
a run is — by facing and distance, not by a stored id. Each end is a conveyor
cell with a visible housing: it stamps `T.BELT`, blocks walking on its own tile,
turns with **R**, and costs what its catalog row says.

**The cells between belong to nobody, and that is the whole feature.** They
stamp no tile, take no walk grid, reserve no working spot — so you floor them,
walk them, stand a shelf on them, and run a second tunnel across them. A
crossing is then two pairs whose spans overlap and whose ends do not, which
needs no code that knows what a crossing is: the span is not a place.

### The four traps, none of which are visible

**`conveyorNext` has to answer across it.** Flow is derived — `conveyorFlow`
([shared/build.js:1812](shared/build.js#L1812)) walks FORWARD from the plain
belts — so an entry whose `next` is null is the end of a run as far as every
loader downstream is concerned. They would keep their feeders and lose their
flow, which draws as a working belt that never delivers.

**One crate in flight, and no more.** A tunnel that queues is a buffer with a
capacity nobody chose, and backpressure is the entire texture of step 1: the
run above ground stops, the tunnel quietly swallows four boxes, and the jam
appears somewhere else a few seconds later. One box makes it a cell with a long
travel, which is a thing the sim already has.

**The pair is DERIVED, never stored.** `repositionFixture` names every field it
keeps, so a stored partner id is a field that resets when you turn one end —
and the press is **R**. What you would watch is a tunnel that works until you
straighten it.

**…and a derived pair is a MATCHING rather than a lookup**, which is the trap
the first shape shipped with. Asked cell by cell, "is there a mouth ahead of me
facing my way" makes the middle of a chain an entry *and* an exit at once: four
mouths in a row are three tunnels, and the middle one hands its box straight
over whatever the run was doing between the two pairs. On the save it was found
on that was a **lift** — every box that arrived arrived correctly, the lift
simply never carried one, and an unbuilt lift and a bypassed one are the same
still frame. So a mouth is an entry only if nobody behind it has already claimed
it (`tunnelClaimed`), and the answer alternates down the chain. The one thing
you *can* see is the wrong tell: both halves of the middle pair draw as entries,
so it reads as art that will not turn rather than as the wrong two ends having
found each other.

**The crate must not be drawn at the mouth.** `d.belt` names the entry for the
whole trip, so `syncPallet` would park the box on the ramp for the length of
the span and then teleport it. The drawn position has to travel the span with
the crate hidden, which is `stepBelts`' tween over a longer gap.

### What `verify:belts` would have to claim

That a shop with no tunnel in it is the old game **to the cent** — the control
that decides whether this is opt-in. That a span cell stays walkable, buildable
and floorable, asserted as values rather than by eye. That two spans may cross
and two ends may not. That the exit backing up stops the entry, and that a
tunnel holds exactly one box while it does. And conservation, because a tunnel
is a new place goods move between, and every one of those in this game has been
a hole.

---

## Step 8 — the ceiling, which is the same square twice

Built. `verify:ceiling`, 195 assertions.

Step 7 says what is actually scarce: **the SQUARE**. A tunnel answers that by
giving the cells between two mouths back, and the answer only works in a
straight line for four tiles. A duct answers it everywhere. A run that hangs
from the roof crosses the shop over the top of the aisles, the shelving, the
checkouts and its own outbound leg, and costs no floor at all.

### It is a field on the PLACEMENT, not four more kinds

`deck` — 0 or `CEILING` — on the placement, read by `deckOf`. An overhead run
wants belts, loaders and junctions, so kinds would be three duplicates that then
have to be kept in step with the three originals for ever; the piece you build
with stays the piece you build with, and the storey is a fact about where you
were pointing. It rides a re-flow the way `mode`, `auto` and `reject` do — named
in `compose` and named again in `repositionFixture`, or the first wall segment
you drag drops the whole run onto the floor.

**Three of the five, and `goesOverhead` is the one spelling of which.** The test
was `def.flow`, which reads as "is this a conveyor" and is true of the two
pieces that have no storey to be on. A **lift** is what joins the two — it
answers `conveyorAt` on both decks off one square, so a shaft laid overhead is
the same shaft said twice, and the only build instruction there has ever been
for one is "put it on the floor at the end of the run". A **tunnel** gives the
SQUARE back, which is the one thing a ceiling has not got to give, and
`tunnelAhead` matches its far mouth on x,z alone — so an overhead mouth pairs
with a floor mouth in the same column and hands its crate down a storey, which
is the hand-off bug below arriving through the one piece whose pairing is a scan
rather than a neighbour. Nothing refused either of them and no assertion failed:
an overhead lift built, drew, and joined two storeys that were already joined.
What it was reported as is the half you can see — the Floor/Overhead switch
appearing for the two tools that cannot use one, which is the green-ghost rule
said about a control. So one predicate answers it in all four places that ask:
the refusal (`canPlace`), the field on the placement (`placeFixture`, and
`buildRun`'s skip, which reads the storey before the refusal is reached), what
the client sends, and which tiles of the palette are dead while you are up there
(`off` in `buildGroups`).

**...and the fourth of those used to be the switch itself, which is the half
that had to be given back.** Gated on the armed tool (`UI.deckable`), the storey
could only be reached by first arming something that goes up there — so the one
thing you most want to do overhead was the one thing you could not do: pointing
at a duct you have already built, to turn it, move it or take it out, needs no
tool in your hand at all, and every one of those presses aims at the storey this
switch decides. The switch is a fact about the TAB now (`DECK_GROUPS`, derived
from `KIND_TOOLS` so an overhead kind authored tomorrow lands the switch on
whichever tab it was filed under), and the promise it was making — everything on
this bar can go where you are pointing — is paid on the tiles instead: what
cannot follow you up is drawn dead, the same deal a tile you cannot afford
already offers, with its own flag rather than `poor` because the price is not
what is wrong with a shelf on the ceiling. Two things keep that honest.
`buildDeck` asks `goesOverhead` again of what is ARMED, so a storey can never
outlive a placement that could use it — and the case that leaves is a fixture in
your HANDS, where the pair reads Floor because that is where a carried shelf
would land. And `toggleDeck` puts down anything armed that cannot come with you,
or you are holding a tool off a button nobody can press, which is the
quiet-build-mode bug one storey up.

**The one line that makes it a second storey is that a neighbour must match
deck.** Flow, lines, branches, jams and hand-offs are all keyed by fixture id
and have never cared how high a crate is; the only thing in the whole subsystem
that assumed one storey is that a neighbour is found by x,z. That is `deckKey`,
and it is the whole feature.

### A ceiling cell stamps no tile and blocks nobody

Which is the point — you get the square back — and it is also the trap. A
non-blocking fixture is invisible to `blocked`, and `T.BELT` is what refuses a
second belt on one square down here; up there nothing stamps anything. So the
ceiling branch of `canPlace` refuses the second one **explicitly**, exactly the
invariant `verify:catalog` asserts about every walk-over kind. Two rules apply
overhead and the rest are skipped: it has to be indoors, because a ceiling is a
thing a roof gives you, and the run may not stack.

### The lift, and why its direction is derived

`lift` is the one cell that spans both storeys — it answers `conveyorAt` on
each, which is what lets a run on either hand to it. Which WAY it carries is not
`rot`: up and down are not quarter turns, and `rot` is the field the **R** key
moves — the shaft's own aim, which is the other axis and is a section of its
own below. So the shaft
runs whichever way the goods already are: a floor run arriving means up, a duct
arriving means down. Build one at the end of an aisle and it lifts; build one at
the end of the duct and it drops.

**Which is resolved in a second pass, and that is the part that took two goes.**
It was first answered inside `conveyorFlow`'s own seeding loop, where the only
feeder it could safely consult was a *declared* one — a plain belt or a tunnel
mouth, aimed by somebody, able to answer with nothing else known — because
asking a loader there is unbounded recursion into the function you are standing
in, and it takes the server down. A shaft fed only by loaders therefore always
guessed, and the guess is "up off the floor". What that looks like is a crate
parked on a lift refusing to come down, in a shop where every other piece works.
The recursion is not a fact about lifts, it is a fact about **when**: after the
forward walk, every loader the run can reach has an answer sitting in the map,
so the same question is a lookup. Lifts resolve there and the walk runs again
from them.

### …and WHICH side it lands on, which is `rot`

`way` answers the storey and says nothing about the square. A shaft has up to
four ways out on the deck it arrives at, and `liftOut` took the first one in
enum order — so which cell a descending crate carried on into was decided by the
numbering of `[0, 1, 2, 3]`, and the only way to route round a wrong one was to
demolish whichever neighbour kept winning. On the save this came off, a lift
landing beside a belt to its east and a tunnel mouth to its north always chose
the belt, and the north leg could not be built at all.

Nothing about it is visible: a shaft that chose the wrong exit and one whose
other leg has not been built yet are the same still frame. Every box arrives
correctly, down a leg that works, and the run you meant simply never carries
anything.

So `rot` means WHICH SIDE IT LANDS ON — the loader's meaning of the key rather
than the belt's, and the two axes are `way` for the storey and `rot` for the
square. Two things keep it cheap. It is a **preference and never a pin**: a
shaft aimed at a wall, at its own feeder or at nothing falls through to the same
scan it always used, or one press of R turns a working loop into a terminus.
And `rot` defaults to **0**, which is the side the scan already tried first, so
every lift in every save answers exactly as it did — which is the control
`verify:ceiling` §4c opens with. The trap it sprang on the way in is one this
document has already recorded twice: `makeLift` wrote `rot: 0` as a literal, and
`compose` rebuilds every record from its placement, so the press could not have
moved it however rotatable the kind said the piece was.

### The three geometry claims, and the one that shipped half-right

A lift hands to a cell **beside** it on the other storey — never to its own
square, which is the lift again and would be a cell whose `next` is its own id.
So the leg from one to the other changes x, z and deck at once, and `alongPath`
interpolates a leg: left as one, the box flies the diagonal, up and over,
through the wall of its own shaft. It is the one hop in the system anybody
watches.

So a riser goes into the polyline, and three things about it are each their own
bug:

- **It is inserted rather than mapped.** `line.pts` was `path.map(...)` while
  `dist` charged the riser, so the box was handed two tiles of travel to spend
  on a leg 1.41 long and cut the corner anyway — with the fix sitting five lines
  above, computed and thrown away.
- **It goes over the SHAFT**, and which of the pair that is depends on which way
  the goods are going. Put on the near cell always, a box going up rises
  correctly and a box coming down steps off the end of the duct into thin air.
  Half of it looks perfect, which is why it lasted.
- **The seam needs it too.** A lift is the last cell of its own line as often as
  a middle one — a shaft with a junction at the top is exactly that — and the
  exit point `stepBelts` appends is a second place the same leg is drawn.

### The shaft's own art: two housings and a glass tube

A lift is drawn as a housing at each storey with a glazed middle between them,
and the two things that make it read are both derived.

Its **pan is a cross** — two grooves, one per axis, at each deck — rather than
the single groove a belt is drawn as. A belt's track lies along `rot`; a lift
has none, so the run can arrive from any of four sides and a groove along one
axis is a shaft the rails visibly stop short of. The cross reaches all four
edges at both storeys, which is also why the filler loop skips a lift: there is
nothing left to fill, and a filler measured off `deckOf` — 0 whichever end you
mean — would be a stub of track on the floor reaching toward a duct four metres
above it.

Its **ends are enclosed but for the portal**, which is `COVERED_KINDS`'
inversion said about the one piece that stands on both storeys: the sides a box
never crosses are panelled, and what is left is the hole it goes in and out
through. Open on all four it is a cage — you see straight through the bottom of
it into the aisle behind and nothing says which way a box is travelling. Two
housings rather than one, because a shaft's ends face different runs: the open
side at the top has nothing to do with the open side at the bottom, and neither
is `rot`.

And the rails inside are **lit rather than moving**. A part carrying `scroll` is
not art on a conveyor — `isSlat` pulls it out of the model and relays it along
the run as a carrier — so the shaft's one authored band came back as a pair of
tall slabs lying in the cage. What moves in a lift is the crate; a second moving
thing beside it is noise.

### An overhead loader reaches both sides

The same four neighbouring floor cells as a floor loader (`armReach`). A duct
over an aisle therefore serves the units on both sides instead of requiring a
separate loader per shelf. The ceiling still buys the square back; it does not
quietly change the meaning of the machine when you move a working aisle up.

The journey is the difference. A floor loader hands straight across. An
overhead loader carries the crate out from the duct and then lowers it toward
the floor fixture, so the simulation path and the rendered spur form the same
L rather than a box disappearing at ceiling height and appearing in a shelf.

`armReach` is in `shared/build.js` because **five** loops enumerate a loader's
sides and all of them have to agree: the swing that pours, the two walks that
say what a run reaches (`conveyorMeets`, `conveyorServes`), and the chevrons and
spurs the renderer draws. Written out four-ways in any one of them, an overhead
loader either serves shelving it cannot see or is drawn reaching it.

### The casing is DRAWN, never authored

Every mark on a run is derived — the corner rails, the loader's chute, the
sorter's blades — and the glazing is the one part somebody reached for a content
row for. `belt-duct` was a deep copy of the belt row with two glass panes
appended, and it was wrong in three ways a straight east-west run cannot show
you. The panes are authored in **model space**, so they lie along `rot`, and a
cell's rotation is not the way goods go through it — every bend in the shop was
glazed across its own mouth. It was one **piece**, so a loader, a junction or a
tunnel mouth hung overhead had no glass at all, which is what a T reads as when
the duct either side of it is enclosed and it is not. And it was **opt-in**, so
a plain belt laid on the ceiling — the obvious press, off the same tool — came
out bare.

So the casing is a fact about the storey and the flow: every overhead cell is
glazed on every side goods do not cross, off the same in/out/branch/pour set the
loader's own panels are cut from. A straight run gets two panes, a bend gets the
two on its outside, a T gets one, and the row you build with is back to being
about how fast the thing is. `belt-duct` is deleted; a placement still naming it
falls back to `belt`, which is what `pieceFor` has always done.

The pan stays **solid**. Making it glass was tried: it removes the dark track
the flow chevrons read against and the run becomes unreadable from across the
shop.

### The bug that is worth remembering: a hand-off has a storey

Every way out of a cell carries the deck it is on, and every lookup that turns
one back into a cell defaults to the **floor** — deliberately, because that is
what keeps every existing caller asking the question it has always asked. Five
of them on the junction path were never told: `beltExit`, the room test beside
it, `sorterWants`, the keep filter and the reject side.

Inside a line that is invisible, because a line's cells are contiguous and
nothing is looked up. At a **junction** it is the whole feature: a sorter is a
line of its own by construction, so every way out of one is a hand-off between
two lines. With nothing under the duct, the box parked on the last cell for the
rest of the save. With a floor run under it — which is the ordinary build, since
you put the duct over the aisle you already automated — it **dropped four metres
onto it** and carried on being a perfectly ordinary crate on a perfectly
ordinary belt. Nothing logs a word either way, and the second one reads as goods
falling off the ceiling.

`verify:ceiling`'s T section is that, said as an assertion: a junction overhead
with a decoy run laid on the floor straight through it, and not one box may ever
be filed on a floor cell or drawn at deck 0.

### How to build one

`E` with the palette up toggles floor ↔ ceiling. Lay the floor run, put a
**Lift** on the floor at the end of it, aim the last floor cell **at** the lift,
press `E`, then lay the duct starting on a cell **beside** the lift — not on top
of it.

### What is not done

- **Nothing routes anybody to a named storey.** A lift is found by A\* the way a
  door is: there is no "send this up", only a shaft with a run on each end.
- **A ceiling sorter's reject side tips over the edge** rather than dropping
  down a chute of its own. It works — the box slides out and `armDrop` sets it
  on the floor below — and it is the one place overhead where the picture is
  weaker than the rule.
- **The chute is a collar**, not a shaft to the floor. A full tube stands in the
  aisle the ceiling was bought to clear, and at this camera it hides the shelf it
  is pouring into.

---

## Step 9 — up is a way OUT

Built. `verify:ceiling`, 401 assertions.

Step 8 gave the shop a second storey and then made reaching it cost a floor
tile, which is the thing the storey was bought to stop. An aisle with shelving
down both sides, a conveyor along it, a loader per unit, an endcap on the end —
and the run stops there, because the only way back is a `lift` and a lift wants
a square. You can have the endcap or the return leg.

So the cell directly above a floor cell — same x, same z, `deck: CEILING` — is a
fifth way out, and the same downward. The `lift` stays: it is what you build when
you want a shaft you can see and a storey change somewhere with nothing under it.
This is what you build when the square is spoken for.

### `acrossFrom` is a separate function on purpose

`stepFrom` is the same-deck rule and it is what a second storey IS: leave the
deck out of it and a duct laid over a run merges with it silently, boxes changing
storey at every crossing, drawn as a conveyor that teleports. A vertical
neighbour reached through the same four-way loop would be that merge with a
nicer spelling. So `acrossFrom` is its own function and every place that
enumerates ways out has to ask for it **by name** — which is what makes the list
of askers short enough to argue about.

### Two things ask, and a plain belt is not one of them

**A junction told to** (`riser`, off on every junction ever built). It shipped
automatic on the argument that you do not aim a branch — `conveyorBranches`
takes every neighbour that is not the straight-on and is not feeding it, and
`rot` only decides which goes first — and a real shop found that wrong the same
afternoon. The difference is what you were pointing at when you built the thing:
a belt beside a junction was laid *at* the junction, where a duct over one is a
route across the shop that happens to pass over it, and a return leg passes over
everything. The shop that found it had a junction feeding an aisle of fifteen
shelves with the return duct crossing its square on the way home: the keen test
held while a shelf could take the goods, and the moment the aisle filled nothing
was keen and a third of everything went up the return leg to park at the end of
it. Every box that arrived arrived correctly, which is the "sorter that does not
sort" report exactly.

**A loader with nowhere else**, which is `choose`'s last resort and the endcap.
Last, and that is the whole opt-in: a loader mid-aisle with a duct crossing over
it carries straight on exactly as it did, so the only machine that ever looks up
is one that has run out of shop.

**And an aisle made entirely of loaders is the shape that found the hole.** "A
loader emptying into a unit hands on to nobody" is a rule from step 2 and it is
true right up to the moment that square gained a way out. A row of loaders with
no plain belt in it never reaches the forward walk — nobody has a feeder, so
every cell of it lands in `conveyorFlow`'s leftovers — and down there the endcap,
aimed at its shelf, was declared a terminus one line before anything asked about
the rise. Same build, working or not depending on whether there happened to be a
belt somewhere upstream, with nothing on screen to say which. The leftover rule
is narrowed rather than deleted: a loader with nothing overhead is still a
terminus and still answers `null`.

A plain belt points where it points. A tunnel mouth answers with its far mouth. A
lift is resolved by `liftTo` and is excluded at both ends of a rise — its own
square on the far deck is *itself*, so "straight up" would be a cell whose next
is its own id, which is `liftTo`'s own guard said one storey along.

`throughR` is never asked of a rise and must not be. It is what tells a run apart
from a spur, and a cell carrying on straight up because the cell below it happens
to be a conveyor is a column rather than a line.

### The rise sits between the units and the ground

`armSwing` is a ladder — shelving first, then a pad, then the floor it faces —
and every rung of it is about a box **leaving** the network. A duct overhead is
not: `stepBelts` carries the box up the moment the swing declines, and a box on a
run beats a box on the floor for a hire to find. So the rise goes above the
ground drop, and that ordering is the difference between a feature and dead code:
the endcap this exists for has walkable floor beside it, which every loader in
every shop does. It turned out to outrank a **pad** as well, which the sweep
found by accident — the row it picks happens to sit beside the drop-off.

A jammed duct means the swing declines and the box waits on the loader, which is
what every other cell on a run does with a full cell in front of it. Dropping it
because the duct was busy for a second and a half would be the automation quietly
handing itself back to the crew.

### …which turned out to be a rule about the whole ladder

Preferring the rise over the ground was not enough, and it took a screenshot to
see why: it only holds the loader whose *own* next cell is the duct. Every loader
**upstream** of that one still had a horizontal way on, so the first of them with
a full board and a walkable tile beside it emptied the box onto the floor long
before it ever reached the return leg. Every box that came off was one a shelf
genuinely refused, so the machine reads as working — and what you watch is a
conveyor that spits your stock out whenever it gets busy.

So the off-ramp is at the **terminus** and nowhere else. Step 2's reason for it
is still the right reason — without an exit a crate nothing wants rides for ever
— but a dead end has stopped being the only shape a run comes in, and the whole
point of a duct is that what the shelves would not take goes back over the top
and round. The rule is now one sentence a player can hold: *a loader only puts a
box down when the run has run out.* The narrow version's answer depended on
whether something four cells away happened to be a duct, invisibly.

A full loop circulates rather than spilling, which is what a loop IS: the boxes
going round are the buffer, and they are the signal that the shop is backed up.
Every dead end keeps its off-ramp, a skip still takes what nothing wants, and a
junction still has `sorterEject`. `verify:belts` §16b is the pair to §16, and the
two of them are the whole rule.

### What cost nothing, and it is most of the step

`beltExit`'s hop already adds 1 for a deck change, so a vertical hand-off is
charged correctly. `conveyorLines`' riser branch is `rise && flat` and a rise has
`flat === 0`, so it is not hit and must not be — the box goes straight up over
its own square, which is what `alongPath` already interpolates and what
`dist[i] === ` arc length of `pts` already agrees with. The same is true at a
seam: the exit point `stepBelts` appends is the same x,z one deck along, so the
riser insert there is skipped for the same reason.

Which is what says the line rewrite (step 3b) was the right shape. A whole new
way for goods to travel, and the geometry, the backpressure, the jam readout and
the conservation all came for free.

### The renderer has no vertical anything

Every mark on a run lies on a tile **edge**, and this hand-over has no edge — it
is the same square twice, four metres apart, which is exactly the problem the
overhead loader's chute already has. Three things fall out:

- **A rise is not a direction across the deck.** `conveyorPath`'s `in`/`out` are
  x,z vectors, so `Math.sign` of a rise is `0,0` — not "no exit", a zero vector
  wearing one. Every reader spends it: the slats are laid along `out`, the
  housing's open sides are keyed by it, the end pips are set back along it. It is
  `null` now, which is the answer that function already has for a terminus and
  means the same thing here.
- **A blade cannot describe it.** A sorter's diverter is a slope a crate is
  pushed off sideways by, so the one branch it cannot draw is straight up — and
  drawn anyway it is a bar over the middle of the hub at `atan2(0, 0)`, a
  diverter pointing east on a junction that diverts nothing east.
- **So the join mark is a collar and a post that SPANS the gap.** It shipped as
  a stub — 0.42 against 1.9 — on `DUCT_CHUTE`'s argument that a full shaft
  stands in the aisle the ceiling was bought to clear. That argument is about a
  chute, which is wide enough to post a crate down; a mark has to fit nothing,
  so it can join the two storeys honestly at a fifth of the width. Stubbed, it
  reads as a length of pipe on the roof of a machine, which says the opposite of
  what it is for. It goes on `rec.flow` like every other
  join, so a rise turns amber when the box on it cannot cross — a hand-over left
  off that list is a hand-over that never reports, and the amber tail is the only
  signal a player has for a jam.

And the jam readout itself had the `beltExit` bug one more time: `beltStuck`
looked its ways out up without a storey, so an overhead run backed up solid
reported itself clear because the aisle below it had room.

### The section of `verify:ceiling` that had to change, and why it is not a loss

Section 7 laid a floor run straight through the square a ceiling junction stands
on, and asserted that no box ever arrives downstairs. Step 9 makes that square the
junction's fifth way out, so the decoy is no longer a decoy: it is a connection,
and a deliberate one.

What the section is about survives, because the bug it was written for is a
**lookup** — every way out of a junction is a hand-off between two lines,
resolved by turning a way out back into a cell, and read without a storey that
answered the floor. So the decoy moved under the two **exits**, which are the
squares those lookups name, and the hub has nothing below it. Both branches still
have a floor cell waiting to catch a hand-off that forgot which deck it was on.

### A shaft can be TOLD, and that is where the pass-through came from

Deriving a lift's direction from its feeder is better than any setting right up
until two runs arrive on the same square — which is how the two levels of one
loop rejoin, and is the ordinary thing to build once a duct exists. There is
nothing to derive there, so `liftTo` takes the floor's arbitrarily and half the
shops that build it get a shaft lifting crates away from the run they were
trying to merge into. Nothing on screen is wrong: the storey a shaft carries to
is not something you can point at.

`way` — `null` / `up` / `down` — is a field on the placement and deliberately
**not** `rot`, because up and down are not quarter turns and `rot` is spoken
for: it is which SIDE the shaft lands on, one axis over.
`null` is every shaft ever built and derives exactly as before. It rides
`compose` and `repositionFixture` the way `auto` and `reject` do, or R clears it
through the back door.

**The pass-through is free and is not a fourth setting.** A shaft told Down
hands to a floor cell beside it, so a crate that arrived along the floor carries
straight on into that cell and one that arrived overhead descends the shaft into
the same one. Two feeds, one exit.

One thing it needs that `auto` does not: the press **re-flows**. A sorter's
`auto` is read by `sorterOut` at the moment a crate arrives, so mutating it in
place is honest; `way` is read inside `conveyorFlow`, which is cached against
the four arrays by identity — mutate it in place and every reader gets the map
from before you pressed the button, until somebody builds something. Which is a
setting that takes effect next Tuesday, and reads as the button not working.

### The bug worth remembering: a roof is a fact about the WALLS

`canKeep` exists because "where" is not a fact about a shelf — knock a hole in
your wall, un-enclose the building, and every fixture in it reads as outdoors
and gets shed. Step 8 rebuilt that bug one storey up. The ceiling branch skips
everything about the floor and keeps two rules, and both were read as facts about
the duct; the roof is not one. Enclosure here is shop-wide and **all-or-nothing**
— take enough of a wall out and `computeIndoor` answers *zero* indoor cells
rather than fewer — so one accidental delete failed "there is no roof there" for
every overhead cell in the building at once and `compose` shed the lot.

Refunded in full, which is why it does not read as theft and why nothing logs
it: what you lose is the build, and what you see is your entire ceiling gone for
a gesture the game called a warning. Reported from a chair, which is the only
place it could have been found. The rule is narrowed rather than deleted — you
still cannot *lay* a duct under open sky — and `verify:ceiling` §9b is both
halves.

### What is not done

- **Nothing routes a box to a storey.** A rise is taken because there is nowhere
  else or because a junction split onto it, never because anything wanted to be
  upstairs. There is no "send this up".
- **A floor junction sealed on all four sides is a hood with a box going through
  it.** The housing's open sides are cut from the x,z set the walls are, and a
  rise contributes none — so a junction whose only exit is upward is panelled
  shut and the crate rises through the roof of it.

---

## Step 10 — a tunnel is a lift that goes down

Built. `verify:ceiling` §12, and `verify:belts`' tunnel sections restated.

The tunnel and the lift did the same job — carry a box between two places a
conveyor cannot reach across — and they did it with two completely separate
pieces of machinery. The lift had `crate.deck`, a fraction between two storeys,
and a gate (`shaftGrant`, `shaftBusyUntil`, `shaftEndpoint`) that let exactly one
crate into a shaft at a time. The tunnel had `underPiston` counting 0..2 through
a stroke, `underRise` for the far end, `underMouth` as an owner, a map of owners
rebuilt every tick, a `carrier` record per crate on the wire, and a `travelDt`
that spent part of each tick holding the box still while the carrier moved.

Every one of those is a second spelling of *a box is between decks*, and two
spellings of one fact are two state machines that drift.

### The span dips

`BASEMENT = -1` is a **storey below**, and it is an address rather than a place
you build. Nothing may be placed there: `goesOverhead` is unchanged, `canPlace`
never offers it, and no cell ever answers `deckOf` with it. What lives at −1 is a
crate, in transit, and nothing else — which is exactly what a span was already.

`conveyorLines` inserts two corner points at that deck, so the leg between two
mouths stops being one long flat edge and becomes the shape a shaft already has:

```
      entry                              exit
  ──────●                                  ●──────   deck 0
        │                                  │
        └──────────────────────────────────┘         deck -1
      down          across                up
```

`dist` charges all three legs, for `conveyorLines`' own stated reason — the
crate's one number and the drawn polyline have to measure the same journey, or
every queue behind a tunnel stands a tile out. It is still one `dist` step
longer than a cell, so `wholeLegs` goes on holding the queue at the mouth and a
span still carries exactly one box.

**What retired with it:** `underPiston`, `underRise`, `underMouth`, the owner
map, `UNDER_PISTON_SECONDS`, `travelDt`, the wire's `under`/`mouth`/`carrier`
fields, and the client's `carrierState`. A stroke is a cell-time at the mouth's
own rung now, which is what `speed_mult` on a tunnel already meant everywhere
else.

### Three things this cost, and each is worth knowing

**`beltHidden` is "at the bottom", not "below the floor".** The two vertical
strokes are the half of a tunnel there is anything to watch, and a box that
vanished the instant it started down would be a piston animating an empty shaft.
So only the leg AT `BASEMENT` — the one with nothing drawn along it — is hidden.

**On screen the storey is a well, not a storey.** The sim thinks in decks
because that is what makes this the lift's mechanism; the renderer spends the
same fraction on the piston's own stroke (`crateY`). A box that really sank four
metres would be four metres of hole nobody can see into.

...and for two steps that well was not DRAWN, which is the half that made the
sentence above read as an excuse. The ground under the shop is solid — one apron
box, the size of the world, from y 0 down — so a carrier sinking into it was not
going underground, it was being clipped by it. What you watched was a crate
dissolving at floor level over a machine with a dark square on top, which is the
shape of a rendering fault with the simulation doing exactly what it says. The
well is cut now: `buildWorld` puts a hole in the apron (a `Shape` with one hole
per mouth rather than a box) and lays the mouth's floor slab as a four-piece
collar round it, and `attachTunnelPiston` lines it with four walls and a pan.
Two things fell out. The drop went from 0.265 to `UNDER_PISTON_DROP` — the old
figure was the depth of a well that did not exist, and a crate's goods stand
about half a tile proud of it, so a box that had finished its descent still had
the shopping above ground when `beltHidden` took it away. And `UNDER_DECK_LIP`
stopped being its own 0.30: it is `WELL_HALF`, because the rail stub and the
hole edge drifting apart is a length of track hanging over open air.

**A mouth's carrier is the LIFT's carrier**, which is one `buildPiston` and one
`strokePiston` for both. They were two — a sleeve-and-rod up the shaft, a single
thin post down the well, on two sets of constants a hair apart — and that is the
same two-spellings trap `mouthSink` retired on the clock side, said about the
geometry.

**A mouth's carrier is found by POSITION, not by `belt`.** A crate keeps the id
of the cell it last left for the whole of a long hop, so the far mouth's own rise
would never appear under its id — the box would climb into view half a cell up
the shop. `mouthSink` and `drawPosition` both match on where the box actually is.

### ...and now it can come up on the other storey

`riser` — the sorter's own field, on the piece that is now the same mechanism.
Set on a mouth, its span carries straight on past the floor and hands to the run
overhead; off, it surfaces onto the line it faces, which is every tunnel ever
laid. One field, one message (`sorter-riser`), one row on the menu: a
`tunnel-riser` beside it would be two spellings of a switch that means the same
thing, which is the split this whole step exists to close.

It is **chosen rather than derived**, for `sorter.riser`'s reason exactly: a duct
over a mouth is a route across the shop that happens to pass over that square,
and a return leg passes over everything. And it is **guarded on there being a
cell up there** — a mouth switched on over bare roof is a terminus, and the run
simply stopping is the one failure that reads as the toggle having broken the
tunnel rather than as an empty ceiling. That is the shop where you flip the
switch before laying the duct, which is the order anybody would do it in.

So the three journeys are: underground→floor (the control), underground→ceiling
(the toggle), and floor→ceiling, which is the lift and always was.

### What is still open

- **The gate is not shared yet.** A tunnel gets one-box-per-span from
  `wholeLegs` and its queue from the pitch clamp, which is what it had before
  there was a piston at all. The shaft's own gate — the alternation that stops a
  permanent queue on one storey monopolising a shared square — is still lift-only,
  and its arithmetic is hardcoded to the `0..CEILING` pair. A mouth only needs it
  once something can feed a tunnel from two storeys at once.
- **An entry cannot be fed from the ceiling.** The toggle moves the far end's
  output. Taking from a duct is the ceiling piece's decision (a sorter's `riser`,
  a loader's last resort), which already works — but a plain overhead belt
  pointing at a mouth's square still carries straight on.
- **Nothing routes a box to a storey**, which is step 9's open item unchanged.

---

## Step 11 — the map, asked about one thing

Built. `Scene.flowFocus` and the `focus` argument to `setFlowOverlay`
([client/render/scene.js](client/render/scene.js)).

The conveyor map says the network is well formed. That is a different question
from the one anybody standing in a shop actually has, which is *how does bread
get to that shelf* — and with eleven runs and four junctions on screen, the map
answers it by making you follow a cyan line with your eye through every fork and
remember which one you were on. It is the same failure the map itself was built
for, one level up: every mark is correct, and the shape you want is not one of
them.

So the map takes a subject. **Pick a fixture and everything the trace does not
touch goes grey.** No mode, no second gesture, no new key: the selection is the
one you already make by tapping a shelf, and the map is a switch in the Menu
that was already there.

### A ROUTE, not a reachable set — which is the whole step

The obvious build is a flood: light every line a box could get here from.
`conveyorLines` already hands back `feeds` (who hands to this line) and `ways`
(who it hands to), so it is a walk over one of those and no new walk of the shop.

It was built that way first and it does not work, for a reason that only shows up
in a shop worth asking about: **the runs all join up.** Measured on `demo-world`
— 72 belt cells, 23 loaders, 4 junctions, 23 lines — the upstream set is **15
lines of 23 whatever you pick**, so every shelf in the building answers with the
same picture. What that reads as is the map ignoring you, which is exactly the
report it came back with, worded as "colours don't change".

The union of the **shortest** ways in is 5 or 6 lines, and it is a different 5 or
6 per aisle. So: hop distance upstream from what you picked (breadth first — they
are distances, not a visited set), then walk back down from every line a box gets
ON, meaning one nothing feeds. A ring has none of those, so the far end of the
walk stands in for one, which draws the loop as the way in that it is.

**Upstream only, whatever was picked.** A unit is an end and has no other
direction. A belt does, and lighting where its boxes go on as well doubled the
picture on the same save — 10 or 11 of 23 — for a second claim drawn in the same
ink as the first. The question people bring to this is where the goods came
*from*; the one that arrives with it, where does this run go, is the map they
were already looking at.

Which loaders reach a unit is `armReach` + `covers` — `conveyorMeets`' own pair,
because a loader fills whatever is beside it rather than the side it is aimed at,
and a pen is four cells with its record on the min corner.

### A selection of several is several routes, walked one at a time

Shift-picking six shelves is the one gesture that means *these*, so the subject
is the whole selection and the answer is the union — a route to each. Which is
**per subject and not one walk seeded with all of them**, and that is a real
trap rather than a tidiness: distances from a shared seed set are distances to
the *nearest* of them, so a trunk feeding two picked shelves would draw the way
to the closer one and nothing at all for the other. A selection of six answering
with one route is a readout that quietly ignores five of the things you pointed
at.

It stays legible because routes overlap. On the same save: one shelf is 6 lines
of 23, a whole aisle of five is the same 6, two aisles is 9, and every served
shelf in the building at once is 12 — still fewer than the flood lit for a
single shelf.

### The three decisions that are not obvious

**A subject the network has never heard of returns null rather than an empty
set.** "Nothing feeds this" and "you are not asking about the belts" are
different answers, and greying the whole shop because somebody opened a till is a
readout that looks broken. The map goes back to being a map.

**The mute outranks amber and not red.** A tug is always a mistake and is worth
seeing wherever it is; a dead end is the ordinary state of a run somebody is half
way through laying, and in a shop with eleven of those it is most of the picture.
Grey it, or the trace has nothing quiet to be loud against.

**Muted, never hidden.** A map with the other runs taken out is a map of a shop
you are not in: the lit route would have nothing to be shorter than, and no
junction to visibly *not* take.

And it is the shortest way rather than a prediction. What a junction does with
any given box is `sorterOut`'s answer and it depends on what is in the box —
nothing here claims otherwise. The lit route is the way in, and where it looks
wrong is where you go and read the sorter.

### What is not done

- **No sweep.** `flowFocus` is a method on the renderer, and every `verify:*`
  drives `Game` — so nothing headless can reach it, which is true of the whole
  overlay and is why the overlay has never had one. The claim worth pinning if it
  moves into `shared/` is the one the first build failed: that two shelves off
  different spurs of one trunk light **different** routes. A count passes on the
  flood; only a comparison of the two sets catches it.
- **It says nothing about volume.** Which of three lit runs actually delivers the
  bread is step 5's question, not this one.

---

## Step 12 — the packer, which is a crate that stands still

**Proposed. Nothing in this section is built.**

### The hole

A van backs onto the dock and sets down what it brought: four eggs in one box,
four bread in another, four lettuce in a third. Nothing downstream of that
moment can make one trip out of it.

A **hire** cannot: `wholeCrate` refuses a box that is not worth more than an
armful, `fit` scores each of those at four, and `fillHands` tops up only a kind
already in the arms — so they leave with four units and walk the shop three
times, looking busy the whole way. That is the case `packs` exists for, and it
is a *rung*: you buy it on one worker, it works where they are standing, and a
shop with no crew on the bay has nothing.

A **belt** cannot either, and this is the half nobody has written down. A run
off the dock carries whatever it is handed, and every loader down it is asked
one question — *does the unit beside me want anything in this box* — so three
part-crates make three journeys down the same line to three different aisles.
The conveyor did not fix the trip; it made the same three trips without a
person. Every box arrives correctly, which is what makes it invisible.

### The shape

A fixture on a run that **holds one crate and fills it from the crates going
past.** A box arrives, it takes what it wants, the remainder carries on, and
when the held box is worth a journey it is released onto the line.

Dock → packer → run. What comes off the van is consolidated once, at the one
place in the shop where everything is guaranteed to pass, and every trip after
that is a full box.

It is the **sorter read backwards**, and that is the argument for it being a
piece at all. A sorter is one line in and several out, deciding by where the
goods can go. This is several boxes in and one out, deciding by the same
evidence. The shop already owns half of that sentence.

### It holds a CRATE, not an inventory

This is the whole of what makes it affordable, and getting it wrong is the
seventh place goods can live — the thing [the argument at the top of this
file](#the-decision-that-makes-this-affordable-a-belt-carries-crates) spends
four paragraphs refusing.

What it holds is an ordinary `deliveries` entry filed on its own cell, exactly
as `armHolds` already describes a box sitting on a loader. So spoilage ages it,
`binOrphans` sweeps it, `stockCrates` counts it as supply the shop owns,
`homeSupply` stops the buyer ordering against it, the renderer draws it with the
model it already has, and a save that predates the piece is unchanged. **No new
container, no new reader, no new way for stock to go missing.** A packer holding
six loaves is a crate holding six loaves that happens to be parked.

Which also settles the pickup question by inheritance: `floorCrates()` is "a box
anybody may walk up to and lift", and a box on a packer is not one, for the same
reason a box riding a belt is not — `unload` scores a stray at `stray * 1e6`, so
a crate that answered it would have every stocker in the shop abandon the bay
and queue up at the machine the packer exists to make unnecessary.

### What it is filling the box FOR

Not an authored list. The shop already computes what it wants in four places and
a fifth copy is the one that drifts.

`fillCrate` is the existing sentence and it should be the same one here:
biggest pile first, bounded by `roomAcross` less what is already in this box
heading there. That last subtraction is not a nicety — a packer that filled
itself with what the shop has no room for is a full crate walked to one board
and carried home again, which is `verify:pack`'s own centrepiece said about a
machine.

`assigned` is the override, and it has to be, for `roomTakes`' reason exactly:
**you ticked it, so it is yours.** A packer ticked for eggs and milk builds that
box and lets everything else past. A packer nobody has ticked reads the shop —
which is the opt-in, and means no press is needed for the thing to be useful.

### The three ways it can go wrong, in the order they will happen

**1. `LOT_KINDS` is 3, and a shopping list is not.** A crate holds three kinds.
So "wait until the order is complete" can express *at most three*, and a packer
ticked for six is a box that can never be finished — a permanent stock sink,
holding goods nothing can reach, with a lamp saying it is working. This is the
given-up-board bug with a roof on it and it is the single most likely way this
feature ships broken.

Two honest answers and they are not the same feature. Either the tick list is
**capped at three at the menu**, where the refusal is a sentence you can read;
or a full box is released and a **second** one started, which makes the piece a
consolidator rather than an order-assembler and quietly gives up the half the
pitch was about. Raising `LOT_KINDS` is not an answer — it is a number four
subsystems read, and moving it for one fixture re-prices every armful, every
van and every board in the game.

**2. It must never hold for ever.** A box that is waiting for a kind the shop
has stopped buying waits for the rest of the save. The release rule has to be a
disjunction, not a completion test: **full** (`CRATE_UNITS`), or **satisfied**
(every ticked kind present), or **stale** — nothing has been added for N
seconds and what is in there goes now. The third clause is the one that does
the work and the one that will feel wrong to write.

And it needs the lamp. `LAMP_DUD` is the precedent from the last commit: a
machine doing nothing that draws identically to a machine working is a fault
the shop should report, and this piece has *two* such states — waiting for a
kind, and holding a box the line will not take.

**3. It must not fight the packer with legs.** `packs` works out of the yard
only, deliberately (`onAPad`, which is what makes it terminate). A packer
fixture standing on the pad, plucking from crates a hire is packing, is the
larder trap — `armPull` and the loader undoing each other with both of them
correct, which docs/workers.md already names and step 4b already paid for once.
The rule is the same one: **a machine and a hire may not both be the answer to
one box.** Cheapest form is that a crate the packer is drawing from is
`claimed`, the way a hire's target already is.

### Backpressure, which is the one thing it must not break

A box that arrives is **tipped, not stopped**: the packer takes the piles it
wants and the remainder rides on. That is `armTip`'s shape exactly — it tips
pile by pile and the crate carries on if anything live is left in it — and it is
what stops a packer being a plug in the middle of a run.

An emptied box **goes away** rather than riding on as a nothing, which the tip
path already does for a skip.

And the release is an ordinary hand-off onto the line in front of it, so
`stepBelts`' backpressure is untouched: if the run is full, the packer holds,
which is the correct behaviour and needs no code.

### Where it sits

Its own kind in `BUILD_KINDS`, not a loader `mode`. A loader moves goods between
a run and a *unit*; this moves goods between a crate and a crate, and the four
verbs it needs (`armTakes` to probe, a tip, a fill, a send) are a different
ladder from `armSwing`'s. A third mode on a piece whose whole job is a different
sentence is how a kind dies quietly — see the four fallback branches step 1
lists.

**Name it the packer**, not the merger. `MERGE_ROUTES` shipped in step 11 and
means the dumb thing — which of two lines feeding one cell goes first — and a
second meaning for that word is a menu nobody can read. `packCrate`, `packs`,
`fillCrate` and `verify:pack` are the vocabulary already in the game for exactly
this operation.

### What would have to be measured

Nothing, by sweep. `simulate` never lays a belt, so the open question at the
foot of this file applies unchanged: the balance bot is blind to it, and "no
change" would be the instrument rather than the feature. What it is worth is
**trips saved per delivery**, which is a thing you watch rather than a number a
run reports.

The sweep it does need is `verify:pack`'s claims pointed at a machine, and the
one that decides whether this is opt-in: **a shop with no packer is the old game
to the crate.**

---

## Steps 5–6 — written down, not built

**Step 5 — a throughput overlay.** Factorio players live in the production
graphs. [client/report.js](client/report.js) is already "the one menu that is a
picture rather than a list", and `spotScore`'s footfall map is already a
per-tile measurement drawn over the shop. Crates-per-minute per run, with the
jammed cell lit — cheap, and it is where the satisfaction of a working line
actually lands.

**Step 6 — power.** A shop-wide meter, a generator you buy, and a brownout when
you overbuild. It is the most Factorio thing on this list and it is last because
it **re-prices every appliance in the game**: every balance figure in the repo is
a `relaxed` figure already, and this would invalidate the rest. A real `simulate`
project, not an afternoon.

---

## What was deliberately not done

- **Loose units on a belt.** The whole argument above. It buys belt density —
  genuinely the texture of the genre — and it costs the seventh place goods can
  live, which is four subsystems that each fail silently. Revisit only if
  crates-on-belts is played and feels wrong.
- **A belt as painted ground.** docs/lanes.md's sequencing. Rejected on four
  counts in step 1, of which "ground holds nothing" is decisive.
- **A corner piece.** There isn't one and there must not be. A belt hands to what
  it faces; a corner is two belts. Authoring a corner kind would mean the sim has
  two ideas of which way a belt points, and one of them would be wrong at every
  bend.
- **Logistics drones.** Factorio's answer, and it is taken: **the staff are the
  robots.** That is the identity of the whole game, and a drone network is the
  thing that makes the cast pointless rather than the thing that makes them
  redundant.
- **Trains.** The van already drives a lane, backs onto the dock and has authored
  content behind it (docs/deliveries.md). A bigger rig is a `vehicles` row, not a
  mechanic.
- **A belt that moves people.** Factorio belts carry you along. Charming, and it
  puts a second writer on the player's position, which is the one field in the
  game that three systems already argue over.

---

## Open questions

- **Does an arm show up in `simulate`?** Probably not, and that matters. The
  balance bot never runs an appliance, so "no change" from the kitchen half of
  anything is *the instrument being blind*, not the change being free. If the bot
  never lays a belt then belts are unmeasurable by sweep and the honest answer is
  to play them — which memory says is the preference here anyway.
- **What does a belt do to the wage bill in practice?** The pitch is that it
  replaces a hire. If it does not, it is an expensive decoration; if it replaces
  two, the crew stop mattering. This is the one number that decides whether the
  feature is good, and nothing but playing it will say.
- ~~**Can a belt go outdoors?**~~ **Answered, in two halves.** Step 2 made a
  belt `where: 'any'`, so a run reaches the field; step 4b gave the loader the
  verbs to collect one, which is the half that was still missing for two steps
  and made an outdoor run a belt with nothing on the end of it.
- **Should a crate on a belt be pickable?** `pickPallet` picks a pile apart by
  height and `liftCrate` no longer refuses a buried one. A box going past on a
  belt is a moving target, which is the one thing the pointer has never had to
  hit. Leaning: yes, and the belt cell stops while you have it aimed.
- **Does the tutorial need a rung?** docs/tutorial.md is a predicate over the
  snapshot. "You laid a belt" is a trivially cheap one and this is the most
  confusing thing in the game to meet cold.

---

## Build order

1. **The belt.** The kind, the drag, the downstream-first tick, backpressure, the
   four quiet-death branches, and the crate's one new field. At the end of this
   you can lay a loop and watch a box go round it. **Play this before step 2** —
   it is the step where crates-on-belts is either right or is not.
2. **The arm.** The take-from-behind/give-in-front rule, `pourInto` at the far
   end, and — the actual work — the four hire rules it must borrow rather than
   reimplement. At the end of this the shop stocks a shelf with nobody walking.
3. **The sorter**, the pure-crate rule, and the drag. `verify:belts` already
   covers steps 1–2 and grows two sections rather than being written fresh.

Steps 4–6 are not started.

Done as of step 2: `docs/belts.md` has its row in CLAUDE.md's doc table and
`verify:belts` has its paragraph in the sweep list — the sweep is the only thing
that will ever say whether any of this is still true.

### What laying one is like today, and why that is step 3's problem

A belt is placed **one cell at a time**, off the palette, like a shelf. A run
across a shop is therefore twenty presses, and every one of them re-flows. That
is not a design decision, it is step 3 not being done yet: `groundStroke` and
`edgeRun` already carry the drag, the cap and the two-ends-on-the-wire rule, and
the direction of the drag is the direction of the belt, which is the one gesture
in the game where a facing is unambiguous.

It is worth knowing before playing it, because twenty presses is exactly the
thing that will make somebody conclude belts are tedious rather than unfinished.

---

## What is lacking

Audited at day 221 of `demo-world` — 115 conveyor cells, 24 lines, 4 lifts, 12
tunnel mouths, 4 junctions. Everything below is a gap rather than a bug: the
routing rungs in *Where a crate goes* all answered correctly.

**1. A line that reaches nothing is silent, and that is the big one.** 32 of
those 115 cells have a forward walk that meets no shelf, hopper, skip, pen or
bed — so a box put on one of them rides to the end and stops. Every readout in
the game says the run is fine, because every rung of it *is*: the chevrons point
somewhere, `conveyorLines` cuts a clean graph, and the flow overlay draws it in
OK-green. `whatThisCosts` warns per CELL ("nothing in front of it", "nothing
beside it to work") and nothing anywhere asks the question about the LINE. The
sorter is the one piece that already knows — `sorterWants` is exactly this walk
— and it keeps the answer to itself, so what a dead line reads as is a junction
that will not send anything down it.

  The cheap fix is one colour: `conveyorMeets(L, head).shelves+stations+bins`
  empty ⇒ draw that line in `FLOW_INK.warn` and cap it with a marker. It costs
  one call per line on a walk that is already cached, and it turns "goods go
  where I think" from a thing you reason about into a thing you look at.

**2. There is no per-crate trace.** *Half answered by step 11* — the map now
takes a subject, so "which runs could get a box to that shelf" is a thing you
look at rather than reason about. What is still missing is the half about a
*decision*: a junction's roof marks say which way it sent the **last** box, and a
crate that took a line you did not expect leaves nothing behind to explain
itself. The explanation is a four-rung ladder over a forward walk of the whole
downstream shop, and "why did that one go left" is still answered by reading
`sorterOut`.

**3. `sortChoice` is never pruned.** It is keyed by crate id and deleted when a
box leaves the junction's line — but a crate lifted off a belt by hand, merged,
binned or spoiled while it holds an entry leaves that entry behind for the life
of the process. Small, unbounded, and invisible.

**4. `conveyorMeets`' cache watches seven arrays and not `unders`/`lifts`.**
`conveyorFlow` watches all four conveyor lists by identity; this one watches
`belts`, `arms`, `sorters` and the four unit lists. It is correct today only
because `compose` rebuilds every array on every re-flow, so the belts identity
changes whenever the lifts one does. That is a coincidence rather than a rule,
and the failure it would produce — a run that reaches a shelf through a shaft
you just built, and does not know it — is exactly the silent kind.

**5. Nothing on a run consults an EDGE.** A crate crosses a wall as happily as
it crosses a strip curtain; `verify:belts` records the pair as a claim that
passes today for the wrong reason. The day a run respects the walls it passes
through, the curtain has to become the exception.

**6. An overhead loader's spur is drawn at ceiling height** pointing at the unit
on the floor below it. The hand-off is right and the picture is a stub into thin
air.

---

## Its relationship to docs/lanes.md

They overlap and neither blocks the other, which is worth stating because
lanes.md §5 currently reads as though belts are downstream of it.

lanes.md sequences belts **after** its direction-for-feet layer, on the argument
that a belt should arrive as *"a cell whose flow moves goods as well as people"*
rather than as a subsystem with its own idea of which way is east. That argument
is good and it is answered rather than ignored: a belt here is a **fixture**, and
a fixture's facing is `rot4` — the same one spelling of a quarter turn that
lanes.md wants everything to share. There is no second convention either way.

What lanes.md is right about, and this document takes as a debt: its costing of
belts is correct for the design it assumes, and the only reason it does not apply
is the crate decision. If crates-on-belts is played and rejected, **lanes.md's
sequencing is the correct one** and this document should be re-opened rather than
patched.

The two features want each other and neither needs the other first. A service
corridor with a belt down it is the shop this game has been describing since
`ferry` shipped — and lanes.md step 3, *stock from the rear*, is where an arm
most obviously wants to stand.
