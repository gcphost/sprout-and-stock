# Handoff — animals that roam

Paste this to a fresh agent. Read [docs/pens.md](pens.md) and
[CLAUDE.md](../CLAUDE.md) before touching anything. This is step 2 of the pen,
and the whole of step 1 is built, verified and exported.

---

## The task, in the user's words

> *"convert those pigs, chickens, cows to like actual workers/customers types
> that can move around, we already got fences and gates, we could remove those
> from the actual prop, and require this to be placed within a fenced-off area?
> that way animals can roam free and we can get more than one? like upgrading
> the plot gives us multiple?"*

So, three things, and they are separable:

1. **An animal is a body, not a decal on a shed.** Today `hen-house`'s model
   contains a hen. It never moves, so a pen is a photograph of a farm.
2. **The pen stops carrying its own fence.** You already have wall edges, gates
   and signed ways through. A paddock should be a fenced area you drew, with a
   shelter standing in it — not a 2×2 prop with a fence painted on.
3. **How many animals is a number you can raise** — by the rung, by the acre, or
   both. That is the decision to argue rather than assume.

---

## What already exists (verify each before relying on it)

- **`pen`** in `FIXTURES` ([shared/build.js](../shared/build.js)): `size: 2`,
  `blocks: true`, `where: 'outdoor'`, `anchor: 'useAt'`. Seven pieces, each with
  `produces: {item_id, qty, every}` and a two-rung ladder.
- **`stepPens` / `penFill` / `penCap` / `collectPen`** in
  [server/sim/index.js](../server/sim/index.js). `qty` and `filledAt` live on the
  layout record and ride a re-flow through `carryOver`.
- **`verify:pens`** — 88 assertions. It must stay green, and most of it should
  still be true afterwards: the clock, the stall, the save round trip, R.
- **Fences and gates** — `E` and `WAYS` in [shared/edges.js](../shared/edges.js).
  `shopperCanCross` is already a function of the STEP rather than the edge.
- **`computeIndoor`** — floods from the map border through the edges. Read the
  trap below before assuming it answers "is this animal fenced in".
- **Actors** — `syncActors` (client/render/scene.js) drives both
  `state.players` and `state.customers` off one path, so a third population is
  cheap to *draw*. It is not cheap to *add to a list*; see below.

---

## The three traps that will decide the shape

### 1. Enclosure is shop-wide and all-or-nothing

CLAUDE.md says this at length and it is the single most likely way to get this
wrong. `computeIndoor` answers "inside the shop", floods from the map border,
and returns **zero** indoor cells when the shell is breached — so anything
phrased against it fails everywhere at once rather than a bit.

A paddock is a *second, local* enclosure question: "which cells are fenced in
with this shelter". That is a flood from the pen's own tile, bounded by `SOLID`
edges, and it is not `computeIndoor` with a different argument. Decide early
whether it is:

- **a flood** (draw any fence, the game works out the field) — elegant, and it
  re-floods on every re-flow, which build mode fires on every wall segment; or
- **a painted pad** (`GROUND`, like `break`) — "how big you paint it is how many
  it holds", which is the yard's promise and the break area's, is already proven
  twice, needs no flood, and cannot be broken by a gate left open.

The second is duller and much likelier to be right. Argue it, don't assume it.

### 2. A container whose membership implies a fact

`this.players` means "a person with hands" and `this.customers` means "somebody
who might buy something". Putting animals in either is the `inACar` bug on a
larger scale: `stepMood` drains patience over `this.customers`, `measureOccupancy`
counts the crush, `moodAverage` averages them, `removePlayer` drops what they
were carrying, `payWages` pays the roster. Every one of those is correct today
and silently wrong the moment a pig is in the list.

A third list is probably right. What that costs is the snapshot, the renderer,
and every sweep that counts bodies — say so out loud rather than discovering it.

### 3. Anything that moves needs somewhere it may not go

A shopper is kept in by walls and by `shopperCanCross`. An animal wandering onto
the shop floor, into the road, or through the car park is the failure, and it is
the one thing here that IS visible in a screenshot — which makes it the only part
of this feature a screenshot can verify.

---

## Questions to put to the user before building

1. **Fenced flood or painted paddock?** (See trap 1. Recommend the pad.)
2. **Do they need feeding?** docs/pens.md lists this as deliberately not built,
   with the reason. Roaming makes it tempting. It is a second hopper and a second
   way for the farm to jam.

---

## What one animal is worth — decided

The obvious fork is "each animal produces" against "the field produces and the
animals are the picture of it", and both are wrong in their pure form. Four hens
each with their own clock and their own little pile is four clocks, four trays
and four stalls — and animals that are only a headcount readout are the "tier
that changes no number" trap wearing feathers, a visible thing that means
nothing.

**A head is a DIVISOR on the one clock.** `every / heads`, and nothing else
moves: one clock, one tray, one stall, one collect verb at one gate. Every
mechanism step 1 built survives verbatim, and `verify:pens` should still pass
nearly whole.

Three things follow, and each is the reason to prefer this:

- **Heads come from the paddock**, one per N cells — the break area's rule and
  the yard's, said a third time. How big you painted it is how much it holds.
- **Heads and the rung stay different knobs.** `capacity_mult` is how long you
  may leave it; heads are how often you must come. Fold them together and the
  field needs emptying at the same interval whatever its size, which is the
  decision gone. docs/pens.md already argues this split — do not undo it.
- **One head is today's numbers to the digit.** Nothing rebalances, no shop that
  never painted a paddock changes by a cent, and that is also the sweep's
  control — the assertion that decides whether the whole step is opt-in.

The shelter therefore keeps the goods, and it has to: collecting from one gate
survives roaming, and collecting from a wandering pig does not.

---

## What to keep from step 1

- `produces` on the piece, and the split from `yields`.
- The **stall**: a full pen accrues nothing. That is the whole texture and it
  should survive whatever the field becomes.
- `size` on the KIND (`canPlace` is pure and has never seen the catalog), and the
  three helpers everything goes through: `footprint`, `footprintMid`, `covers`.
- `binOrphans` clearing a bed whose crop row has gone.

---

## House rules

From `.claude/skills/rules`, and the user enforces them: R3 (reuse before
writing, 600 LOC hard cap), grep before assuming an identifier exists, ELI5 TLDR
bullets, **never silently pivot scope — stop and ask**, no legacy fallbacks,
check `docs/` first and document what you build in the house style. "mate" means
re-read your last message.

`npm run verify` must be clean (37 sweeps, ~1 min). `npm run export && git add
data/seed` before committing, or content you author lives only in your database.
Do **not** run long `simulate` loops — three 60-day runs pegged the user's laptop
and `simulate` is blind to pens anyway.
