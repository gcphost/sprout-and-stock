# Lanes — where people may go

Status: **all proposed.** Nothing here is built.

---

## The hole

The shop can say who may cross a **line** and it cannot say anything at all
about a **square**.

Step 15 of docs/building.md gave a doorway a sign on it: `WAYS`
([shared/edges.js:86](shared/edges.js#L86)) makes an opening staff-only, in-only
or out-only, and `shopperCanCross`
([shared/edges.js:263](shared/edges.js#L263)) is the first rule in the game whose
answer depends on who is asking. That is a genuinely powerful thing and it is
sold one edge at a time, which means the only way to say *"my crew go round the
back and the customers stay out of it"* is to **build a wall around it**.

Three things fall out of that, and the third is the one that costs the fantasy.

**A back-of-house has to be a room.** Enclosure is what makes a staff door mean
anything, so the only expressible version of "staff area" is a walled space with
a signed way in. A metre-wide lane behind a run of shelving is not a room and
never will be — you cannot wall a corridor without the walls eating the very
tiles you were trying to walk down, which is the wall-ring problem step 2 solved
for buildings and never solved for aisles.

**The shop already has the *idea* per fixture and cannot say it per tile.**
`boh` on a shelf ([server/sim/index.js:9874](server/sim/index.js#L9874)) says
this unit is back-of-house: `chooseShelf` filters it out, so shoppers do not
browse it and it backs up the floor instead. That is exactly the who-rule this
document wants, already shipped, already understood by players — and it applies
to a *thing* rather than to the ground, so a shelf can be staff-only and the
tile in front of it cannot.

**And staff and shoppers walk the same floor, always.** `pathTo`
([server/sim/index.js:11924](server/sim/index.js#L11924)) already knows which
sort of thing is walking — `archetype_id` is the field only a shopper has — and
the only thing it does with that knowledge is doors and crates. A robot restocking
the far aisle cuts straight through the queue, because the shortest route is the
shortest route and nothing in the shop has ever had an opinion about that.

The last one is the whole pitch. **The shop is staffed entirely by robots and
there is no way to route them.** That is a game about automating a grocery store
in which the automation has no floor plan.

---

## The shape

**Ground can carry a rule about who walks on it, the same way an edge already
carries a rule about who crosses it.**

One sentence carries the design:

> A lane is not a wall. Shoppers are refused; your own crew are charged.

And a second one carries the sequencing:

> The direction a cell points is one number, and a belt is that number moving
> goods as well as feet.

Painted with a brush, per cell, as an overlay — the ground you painted stays the
ground you painted, and a rule is a second fact about the same square. Two
independent things you can say about a cell:

- **who** — nobody (the default), *staff only*, or *keep out* (a floor your crew
  would rather not cross)
- **which way** — a flow direction, or none

That is enough to draw service corridors behind the shelving, keep customers out
of them, keep robots off the shop floor, and lay a one-way loop through the
aisles. Add a per-unit **stock from the rear** toggle and the corridor has a
reason to exist: the crew work the back of the shelf and the customer never sees
them.

Belts come last and are a different size of thing — see step 5.

---

## What is already built that this rides on

Most of it, and that is the argument for doing it in this order.

| Piece | Where | What it gives free |
|---|---|---|
| A step-level permission test | `canCross` in `findPath` ([server/sim/pathing.js:100](server/sim/pathing.js#L100)) | The seam. A one-way door is passable one way and a wall the other, so this is already *"may this person take this step"* rather than *"is this edge solid"*. A tile rule is the same signature and needs no A\* change. |
| Who is walking | `pathTo` ([server/sim/index.js:11924](server/sim/index.js#L11924)) | The shopper/staff split, decided once, off the one field only a shopper has. |
| A per-cell surcharge in the hot loop | `stepCost` ([server/sim/pathing.js:77](server/sim/pathing.js#L77)) | Already takes a per-cell lookup (`clutter`), already applies it to one sort of walker only, and already documents why every cost must stay ≥ 1. |
| A cost that reads as a wall and degrades as a cost | `CLUTTER` = 8 ([server/sim/pathing.js:75](server/sim/pathing.js#L75)) | The precedent for the central decision below, argued out in full: *"in a shop with any way round at all it reads exactly like a wall, and the degenerate case degrades instead of breaking."* |
| A preference that is never a requirement | `PAVED` / `ROUGH` ([server/sim/pathing.js:44](server/sim/pathing.js#L44)), `ROAD_COST` | Two features whose whole design is "weigh it, never demand it", and the admissibility rule that goes with them. |
| A brush that paints an area | `groundStroke` ([shared/build.js:1310](shared/build.js#L1310)), `canPaintGround` ([shared/build.js:1419](shared/build.js#L1419)) | The drag, the cap, the two-ends-on-the-wire rule, the border-ring refusal, the "you cannot take ground out from under something" refusal. |
| A sparse overlay that never touches the arrays | `groundIndex` ([shared/build.js:1364](shared/build.js#L1364)), `PAINT` ([shared/build.js:369](shared/build.js#L369)) | The whole pattern: authored per cell or per face, sparse on the wire, and provably unable to move a tile. `verify:paint` is the sweep that says so. |
| A rule the queue must not grow through | `queueLane` refusing `RULED` ([shared/build.js:903](shared/build.js#L903)) | The exact line a lane needs, with the reasoning already written down: a lane is grown outward and walked inward, so a directional test would answer whichever way the loop happened to ask. |
| A dense mask compiled per re-flow | `layout.indoor`, `layout.blocked` | The shape the rule layer wants: sparse in the save, `z * w + x` in memory. |
| Two sides of a fixture | `behind: 'tendAt'` ([shared/build.js:103](shared/build.js#L103)), `behindTile` ([shared/build.js:506](shared/build.js#L506)), `workSpots` ([shared/build.js:524](shared/build.js#L524)) | Step 3 in its entirety, minus a toggle. A till is already worked from the far side, the generator already reserves that tile, and `spotsOf` ([shared/build.js:649](shared/build.js#L649)) already derives the back of a unit when asked. |
| Back-of-house as a concept players know | `setBackOfHouse` ([server/sim/index.js:9874](server/sim/index.js#L9874)) | A per-unit who-rule, in the fixture menu, already bulk-editable through `Game.bulkFixtures`. |
| Warn rather than refuse | `canPlace` ([shared/build.js:1562](shared/build.js#L1562)) | The house rule for "you may cause this, and here is what it costs you". |

Genuinely new: **one overlay, one lookup in two functions, and one reverse
flood.** Everything else is a brush and a menu row.

---

## Step 1 — the rule layer, and staff-only ground

A `RULES` table in `shared/build.js`, an overlay list on the save
(`world.lanes`), a dense `Uint8Array` on the layout (`L.lanes`), and one clause
in `shopperCanCross`.

### It is an overlay, not a ground kind

The tempting version is a `GROUND` row — `GROUND.service`, a tile, done. It is
wrong twice.

`GROUND` is **one-to-one with `tiles`** (`groundTile` / `groundKindOfTile`,
[shared/build.js:449](shared/build.js#L449)), and a staff lane still has to be
*floor*: buildable indoors, painted with whatever design you chose, counted as
shop by everything that counts shop. A rule-bearing tile value would mean a
staff corridor cannot also be lino, and it would walk straight into the trap
CLAUDE.md already names about `groundKindOfTile` — a lookup whose `?? null`
means "nobody painted here" gains a new answer the day you add a row, and two
callers silently change behaviour.

The second is sharper: **a cell can be both**. A square can be tarmac *and*
staff-only *and* one-way. That is three facts and a tile holds one, which is the
same argument that split `tiles` from `blocked` in step 5 of docs/building.md
and the same one that put paint on a face rather than in the edge array.

So it is `PAINT`'s sibling rather than `GROUND`'s: authored per cell, stored
sparse, and structurally incapable of moving a tile. It makes `BUILD_KINDS` a
five-way partition, which `verify:catalog` counts rather than trusting anybody
to remember.

### One packed byte, because this is the hot loop

Sparse on the wire and in the save (`[{ x, z, w, d }]`, the shape `ground`
uses). Dense in memory, built once per re-flow beside `indoor` and `blocked`:

```
L.lanes[z * w + x]   0 = nothing at all
                     bits 0-1  who: 0 none, 1 staff-only, 2 keep-out
                     bits 2-4  dir: 0 none, else 1 + rot4  (see step 4)
```

One `Uint8Array` read, and **zero is the fast path** — a shop that has never
painted a lane pays one array index per neighbour expansion and takes the same
branch every time. A `Map` keyed `"x,z"` would allocate a string per neighbour
in `findPath`'s inner loop, which is the hottest thing in the game.

Direction reuses `FACING` / `rot4` ([shared/build.js:482](shared/build.js#L482))
rather than inventing a second convention for which way is east. There is one
spelling of a quarter turn in this codebase and there should go on being one.

### Bans for shoppers, a price for staff

**This is the load-bearing decision in the document.**

A staff-only cell is a **wall to a shopper** and an **ordinary cell to your
crew**. A keep-out cell is the other way round — and it is not a wall to your
crew, it is *dear*. Same asymmetry, both times: the shopper side refuses, the
staff side charges.

Refusing a shopper is safe and precedented. A staff doorway already does exactly
this, and the sim copes all the way down: a shopper who cannot path to a shelf
writes it off and picks another, one who cannot reach the door leaves, and
`canPlace` already treats "you may wall your own shelf in" as a consequence
rather than an error.

Refusing **staff** is the bug this whole codebase has a scar from. A hire who
cannot reach the break area never rests again, sits at zero energy and is pinned
at `TIRED_PACE` for the rest of the save — the failure `seatIn`
([server/sim/staff.js:976](server/sim/staff.js#L976)) checks `findPath` for, the
one `verify:break` exists to catch, and the one the deferred re-flow in
`staff.js:767` is careful not to re-create. A hard staff ban on ground means
*any* mis-drawn lane can produce it, silently, in a shop that looks fine, and
the player's mental model is "I painted a floor", not "I severed my payroll".

So keep-out is `CLUTTER`'s bargain, and for `CLUTTER`'s stated reason: eight is
far enough that a robot walks the length of the building rather than cut across
your shop floor, so in a shop with any service route at all it **reads exactly
like a wall** — and when you have drawn it wrong, they squeeze through, badly,
instead of the shop quietly ceasing to function.

A number that behaves like a wall and cannot become one is strictly better here
than a wall.

### The player is never refused

`canWalk` is the player's own test, and docs/building.md's signed-doorway
section already settled this: an edge a shopper is refused and a hire crosses is
still walked by **you**. Lanes inherit it without a word. You are not routed by
A\* at all — `findPath`'s own header says so — so this is a statement about
`canStep`, and the statement is that it does not change.

### The queue

`queueLane` refuses to grow through a `RULED` edge outright rather than asking
about direction, and it must refuse a ruled **cell** the same way and for the
same written reason: a lane is grown outward from the till and walked toward it,
so a directional test gives whichever answer the loop happens to ask for. A
service corridor beside a checkout must not collect a queue.

### What you are warned about

Painting is a stroke, so it is judged as a whole, and `canPaintGround` gains one
consequence — never a refusal:

- **the shopper flood.** `reachable` with `shopperCanCross`
  ([shared/edges.js:349](shared/edges.js#L349)) already answers "can a customer
  get from the door to here", and already does it with a *probe* layout via
  `withEdge`. The same flood over a probe overlay says whether this stroke cuts
  the shop off — and, like the signed-doorway warning, it is a warning, because
  cutting your own shop off is a move.

`whatThisBlocks`'s fixture-stranding flood is deliberately **everybody's** rather
than the shopper's, exactly as it is for doors: a shelf you have deliberately put
in a stockroom must not warn you about itself on every lane you ever draw.

---

## Step 2 — the shop floor is somewhere your crew would rather not be

Step 1 gives you corridors. It does not give you robots that use them, because a
lane your crew *may* walk is a lane they walk only when it is shorter — and a
service route round the back is by construction the long way.

Keep-out is the answer and it is the same one number. Paint the shop floor
keep-out, paint the corridor plain, and the surcharge does the rest: the crew
take the back way whenever one exists and cut through the aisles when it does
not. Nothing new in the code — step 1 shipped the field — but it is called out
as its own step because it is the one that has to be **played** before any of
this is worth anything, and because it is the first thing in the game that will
make a shop visibly slower if drawn badly.

The one thing to watch, and it is a `simulate` question rather than a code one:
a robot taking the long way is a robot doing less work per day. The whole feature
trades throughput for the shop *looking* run by machines that know their place.
That is a fair trade at 8 and probably not at 80, and the honest way to find out
is to play it rather than to sweep it.

---

## Step 3 — stock from the rear

A per-unit toggle on a shelf, a freezer and a hot counter, beside `boh` in the
fixture menu. It is the smallest step here and it is the one that makes the
corridor mean something.

### It already exists, on the till

`FIXTURES.checkout` is `anchor: 'serveAt', behind: 'tendAt'`, `behindTile` is
`anchorTile(rot + 2)`, `workSpots` already returns both with a `role`, the ghost
already draws the two sides differently, the generator already reserves the tend
tile ([server/layout.js:838](server/layout.js#L838)), and `spotsOf` already
derives the back of a unit when the piece says it is open all round.

A shelf with the toggle on stores a `stockAt` the same way a till stores
`tendAt`, and the staff stocking walk targets it instead of `workSpotOf`'s
`browseAt`.

### It must be a preference, with the front as the fallback

Two reasons, and the second is the one that would bite.

`verify:layout` asserts every fixture has a **reachable working spot**, and
`canPlace` warns when it does not. Requiring a rear tile would make most of the
shelving in every existing shop illegal at a stroke.

And `faceAlong` ([shared/build.js:605](shared/build.js#L605)) actively *prefers*
backing a shelf onto a wall — that is its whole second test, `backed` — so the
overwhelming majority of units in the game have no rear tile to stand on, by
design, because the aim assist put them there. A toggle on such a unit does
nothing and must say nothing.

**Do not teach `faceAlong` about it.** The `workable` predicate switches on
`def.behind`, which is a property of the *kind*; make it read a per-unit flag and
every shelf in the game starts holding out for a facing with both sides clear,
which un-hugs your walls and reshapes every generated shop. The toggle is read
where the walk target is chosen and nowhere else. A sweep claim worth having:
`faceAlong` answers **identically** either side of the toggle, which is the
comparison-rather-than-a-value shape `verify:doors` uses for its flood.

### What it buys, and what it costs the player

An island shelf costs you a tile of floor for the corridor behind it. That is the
right price and it is charged by the geometry rather than by a rule: the fantasy
of a crew that works out of sight is paid for in shop floor, and a shop too small
to afford it simply carries on as it does today.

---

## Step 4 — one way

The `dir` half of the byte. A drag paints the flow — the direction *is* the drag,
which is why the two-ends-on-the-wire rule costs nothing here.

### It is a cost for staff too, not a ban

Same argument as keep-out and it applies harder, because a one-way *loop* is the
easiest thing in this document to draw wrong. A pocket you can walk into and not
out of is invisible in a screenshot, invisible in play until somebody is in it,
and indistinguishable from a hire who is simply busy elsewhere. Ban it for
shoppers, charge for it against the flow for staff, and no configuration of lanes
can pin anybody.

### The graph stops being symmetric, and every check in the game is undirected

This is the one genuinely new piece of work.

`reachable` is a single flood over an undirected graph, and every reachability
question in the codebase is phrased with it — enclosure, fixture stranding, the
shopper flood, the seat search. With one-way cells, "can a shopper get from the
door to here" and "can they get from here back to the door" are **different
questions**, and only the first is asked today.

So the warning wants two floods: forward from the door under the step rule, and
**reverse** — the same flood following each edge backwards — from the door.
Anything the first reaches and the second does not is a trap, and painting one is
a warning at paint time.

A\* itself is fine. Manhattan `h` stays admissible because every cost is still
≥ 1, which is the invariant `PAVED`/`ROUGH` and `CLUTTER` are each careful to
state. Do not be tempted to make walking *with* the flow cheaper than 1 as a
reward — that is the exact thing `stepCost`'s header warns about, and it quietly
turns A\* into something that returns *a* route rather than the shortest one.

### `verify:lanes`

Everything here is invisible in a still frame by construction — a robot going the
long way round and a robot going the short way are the same picture — so this
ships with its feature, the way `verify:doors` and `verify:park` did.

- **A shop with no lanes painted is the old game to the cent.** Paths
  bit-identical, both walkers, across generated layouts.
- **A staff-only cell is a wall to a shopper, an ordinary cell to a hire, and
  still walked by you.** One cell, three askers, the `verify:doors` shape.
- **Nothing moves.** Every cell of a furnished shop given a rule, and `tiles`,
  `blocked`, `indoor` and both edge arrays byte-identical afterwards — the claim
  `verify:paint` makes about a wall, said about the floor.
- **No lane configuration pins a hire.** The one that matters. Adversarial
  layouts — a keep-out ring, a one-way spiral, a corridor pointed the wrong way —
  and a hire can always reach the break area, however badly it is drawn. This is
  `CLUTTER`'s degradation claim, and it is the whole justification for a cost
  rather than a ban.
- **A queue never grows onto a ruled cell**, and a till beside a service
  corridor lays its line the other way.
- **Direction is observed**: A→B and B→A differ across a one-way lane. Asymmetry
  is the feature and is otherwise unprovable.
- **A pocket warns.** Forward-reachable and not reverse-reachable, caught at
  paint time, warned rather than refused.
- **Rear stocking falls back.** A wall-backed shelf with the toggle on is stocked
  from the front; an island one is stocked from the back; and `faceAlong` answers
  the same either way.

---

## Step 5 — belts

Deliberately last, and it is a bigger thing than the four steps above it put
together — not because of the direction field, which it gets for free, but
because of what a belt *is*.

A belt is a **seventh place goods can live**. `verify:orphans` enumerates the six
that exist: a board, a crate, your hands, a shoulder, a hopper, a tray, and a
van (and calls that six places of six different shapes). Its whole finding is
that every loop in the sim opens by looking an item row up and skipping what it
cannot find, which is right in each one and adds up to stock nothing can sell,
shelve, spoil or shift. Its stated failure mode is not "the bin is wrong" but
"the bin has never heard of shoulders".

So the cost of a belt is not the animation. It is:

- conservation — `removePlayer`, firing, `saveState`/`restoreStaff`, `homeSupply`
  and `binOrphans` all have to learn about it, and each omission is a silent hole
  rather than a visible bug
- spoilage — goods on a belt are goods somewhere, and `spoilRate` takes a kind
- ordering — `homeSupply` counts what the shop already has, and a belt full of
  bread is supply
- the merge rules — `dropGoods` is the one answer for goods hitting the floor,
  and a belt end that does not call it is a second container, which CLAUDE.md
  says flatly never to invent

What the direction field gives it is the authoring: a belt cell already knows
which way it points, painted with the same drag, using the same `rot4`. That is
the argument for the sequencing rather than for the feature — build the direction
layer for feet, play with it, and belts arrive as *a cell whose flow moves goods
as well as people* rather than as a new subsystem with its own idea of which way
is east.

Nothing in steps 1–4 depends on this and it should not be started until they have
been played.

---

## What was deliberately not done

- **A rule as a column on a `ground` design.** Very tempting — it would make the
  whole feature content rather than code, which is this project's own preferred
  answer. It fails on the same point the `GROUND` row does: the rule would ride
  on the *look*, so there could be exactly one appearance of staff-only ground,
  and marking a cell would repaint it. A rule and a surface are two facts about
  one square.
- **A bitmask of allowed exits per cell.** Strictly more expressive than a single
  flow, and unpaintable — there is no gesture that means "north and east but not
  south". A drag means a direction. It is also the wrong shape for a belt, which
  has one.
- **Making one-way an edge kind.** It is genuinely closer to what a one-way rule
  *is*, and `E` is where the existing directional rule lives. Rejected on the
  gesture again: you would paint the boundaries of a corridor rather than the
  corridor, which is four edges per cell of lane and a drag that means something
  different at every corner.
- **A speed change.** Neither the surcharge nor the flow makes anybody walk
  faster or slower. What a step costs the search and what it costs the walker are
  different questions — `PAVED`'s header says so — and making a lane a speed
  turns a floor plan into a balance change.

---

## Open questions

- **Does a lane cost money?** Everything else painted does, per cell. A rule is
  not a surface, though, and charging for it makes redrawing your service routes
  expensive in a way that argues against experimenting with them — which is the
  whole activity the feature is for. Leaning free, with the *floor* underneath
  already paid for.
- **Should `boh` set it?** A shelf marked back-of-house and a tile marked
  staff-only are the same sentence about two different things, and a player who
  has ticked six shelves has said something the ground could infer. Probably not
  automatic — inferring ground from furniture is the sort of convenience that
  paints over a decision — but the fixture menu could offer it.
- **Does the customer ever see it?** A shopper refused a lane currently just
  routes round it and nothing says why. A shop that has drawn its lanes badly
  looks identical to one that has drawn them well until you read the takings.
  Some visible tell — the same amber the ruled edges get — is probably needed on
  the ground too, at least while the brush is up.
- **Do rooms mean anything yet?** docs/building.md's open question, and this is a
  second caller for it: "the whole of the back corridor" is a region, and a
  labelled enclosure would let a rule be given to one rather than painted cell by
  cell.

---

## Build order

Sliced so the shop is playable at every step, and so the first two are worth
playing on their own.

1. **The rule layer, and staff-only ground.** The `RULES` table, the sparse
   overlay, the dense byte compiled per re-flow, one clause in
   `shopperCanCross`, the queue refusal, the shopper-flood warning, and the
   brush. Nothing about direction. At the end of this you can draw a service
   corridor customers will not enter.
2. **Keep-out.** One more value in the same field and one term in `stepCost`. At
   the end of this your crew prefer the corridor. Play it before step 3.
3. **Stock from the rear.** A per-unit toggle reusing `behind` / `behindTile` /
   `workSpots`, honoured where the walk target is chosen and nowhere else, with
   the front as the fallback. At the end of this the corridor has a job.
4. **One way**, the reverse flood, and `verify:lanes` — which covers steps 1–4
   rather than only this one, because until the graph is directed most of its
   claims are cheap.
5. **Belts.** Not before the above have been played, and not before
   `verify:orphans` has grown a seventh place.

When step 1 lands, `docs/lanes.md` wants a row in CLAUDE.md's doc table and
`verify:lanes` wants its paragraph in the sweep list — the sweep is the only
thing that will ever say whether any of this is still true.
