# Vats — the farm that came indoors

Status: **built — all seven steps.** The farm goes indoors, the Culture Floor is
renamed, three vats and the Former are authored and drawn, crop-side seasons are
gone, the beds are grow racks, the trays stand on the deck, five recipes give
every retired animal a vat route, and the seven pens are off the palette without
a row being deleted. What is left is playing it.

⚠️ **A client rebuild is owed before any of the art or the palette change is
visible**, and `npm run export` before any commit — the content rows live only in
the local database until then.

Two things the build turned up that this document did not predict, both recorded
in their sections below: the roofed-clock holds in `stepPens`/`stepCrops` were
**not** dead once the flag flipped (an indoor bed was placeable, charged for and
permanently frozen), and the crop-side `seasons` field had **seven** readers
rather than the four named here — including `replantable`, which was *emptying*
a bed whose crop went out of season, for a quarter of the calendar, with nothing
logged.

This is a **reskin argued as a design**, and the reason it is worth a document
rather than a commit message is that almost none of it is a rewrite. Every
mechanism [docs/pens.md](pens.md) built survives verbatim. What changes is what
the player is looking at, and one number.

---

## The hole

**The farm is outdoors, and the outdoors is the part nobody likes.**

The report from play was not "pens are broken" — they work exactly as
[docs/pens.md](pens.md) describes. It was that a shop staffed entirely by robots,
selling to a town, with conveyors overhead and a second storey of ducting, has a
**field of pigs** bolted to the side of it. The building is a warehouse. The farm
is a picture postcard. They are two games sharing a save.

The tell is that the thing everybody likes about the farm is the half that has
nothing to do with the outdoors: **making things from scratch.**
[docs/production.md](production.md) is 68 recipes, four hops deep, and its whole
argument is that a graph needs leaves. None of that argument mentions grass.

So the fiction is load-bearing in exactly one direction — it decides the art —
and it is doing no work at all in the other.

---

## The shape

> **The farm moves inside.** Beds become grow racks under lights, animals become
> culture vats, and meat stops being seven buildings and becomes a recipe. The
> field outside becomes floor you can build on.

The load-bearing observation, and the reason this is cheap:

**A pen is already a bioreactor.** Read [docs/pens.md](pens.md) with the word
"animal" struck out and what is left is a machine that fills on a clock, stalls
when full, is collected from one side, and whose throughput scales with painted
floor area divided between the machines sharing it. That is a fermenter and its
cleanroom. Nobody has to build it, because it is built.

| Today | Tomorrow | Code change |
|---|---|---|
| `pen` fixture | culture vat | one word (`where`) |
| `paddock` ground | culture floor | one label, one colour |
| `heads` on a rung | culture lines | none |
| `speed_mult` / `capacity_mult` | how often you come / how long you may leave it | none |
| `body` model | trays, and a tender drone | see step 5 |
| `plot` fixture | grow rack | one word (`where`) |
| crop `seasons` | year-round growing | see step 4 |
| 7 pens → 7 items, 1:1 | 3 vats → biomass → a printer | content |

---

## Step 1 — indoors

Three things stand between the farm and the warehouse, and all three are in
[shared/build.js](../shared/build.js).

```js
plot: { …, where: 'outdoor', … }        // build.js:108
pen:  { …, where: 'outdoor', … }        // build.js:145
```

…and the warning that exists because of them:

```js
if (roofed.length) return `that roofs over ${roofed.length} plots — nothing grows indoors`;
```

[`whatThisUnroofs`, build.js:1687](../shared/build.js#L1687), plus the roofed-clock
holds in `stepPens` and `stepCrops` that back it up.

### It is `'any'`, and never `'indoor'`

This is the one decision in step 1 and it is not stylistic.

Every fixture in every save is a placement at an **absolute tile**. There are
live shops with beds and pens standing on grass right now. `where: 'indoor'`
does not migrate them — `compose` re-judges player placements on every re-flow,
and a re-flow fires on every wall segment of every drag, so the first time
somebody drew a wall their entire farm would be **shed and refunded**. Money
back, so nothing reads as stolen; what you watch is your farm disappearing
because you built a shed.

That is `droppedPlacements` doing exactly what it is for, aimed at the wrong
target. `where: 'any'` is what a skip already uses (build.js:177), it strands
nothing, and it means an outdoor farm goes on working for anybody who wants one.

### What falls out for free

- `whatThisUnroofs`'s `roofed` branch becomes dead for these two kinds — a
  fixture with `where: 'any'` is skipped by that function's own first line.
- A pad may already be painted indoors (`verify:yard` asserts it: walkable,
  never buildable), so the culture floor needs no new rule.
- A vat stands on `BUILDABLE_INDOOR` floor with its culture floor painted around
  it, which is `paddockOf`'s shape unchanged — it floods from the footprint, and
  a pad is never buildable, so the machine could never have stood on its own
  deck either way.

---

## Step 2 — the vats

Seven pens collapse to **three**, and the collapse is the point rather than a
tidy-up.

| Today | Makes | | Tomorrow | Makes |
|---|---|---|---|---|
| Hen House | egg | | **Protein Vat** | protein-biomass |
| Dairy Shed | milk | | **Culture Tank** | dairy-culture |
| Poultry Run | poultry | | **Myco Tower** | fungal-biomass |
| Beehive | honey | | | |
| Pig Pen | pork | | | |
| Turkey Pen | turkey | | | |
| Cattle Pen | beef | | | |

The seven exist because a pen's `produces` is `{item_id, qty, every}` — one
piece, one output, for ever. That is right for a cow and wrong for a fermenter,
and it is what makes the meat aisle **seven buildings that each do one thing**
with no decision between them. You do not choose a pig pen over a cattle pen;
you buy both.

Three vats making three intermediates is a *choice* the moment anything
downstream eats them, which is step 3.

**Every mechanism is untouched.** `produces` on the piece, the `speed_mult` /
`capacity_mult` split, the full-vat stall, `collectPen` and `handOver`, the
`farm` job fold, the loader that empties one. `verify:pens` should pass on a
rename — and if it does not, the rename has changed a rule, which is the sweep
earning its place.

### Milk, eggs and honey do not lose their source

Worth saying because it is the first objection: precision fermentation makes
casein, egg protein and honey **today**, at dairy price parity. The fiction is
not a stretch, and none of those three items has to change at all — only the row
that produces them.

---

## Step 3 — the printer

**Meat stops being a `pen` and becomes a `station` and a recipe.**

This is the half that pays for the pivot, and the argument is structural rather
than thematic. Today the meat aisle is seven fixtures with a hardcoded 1:1
output. As a recipe it is:

```
Protein Vat ─→ protein-biomass ─┬─[Former]→ mince
                                ├─[Former]→ bacon
                                ├─[Former]→ portions
                                └─[Former]→ fillet
```

One machine, four recipes, and the *sorter* has something to sort. That is
precisely what [docs/production.md](production.md) went looking for when it found
that "intersect every recipe's outputs with every recipe's inputs and the answer
is the empty set" — a reason to lay a belt between two machines.

### It fits under the cap with room to spare

Every appliance in the game is a variant of the one `station` row, so
[schemas.js:797](../shared/schemas.js#L797)'s `.max(24)` is how many machines the
shop may ever own. **17 are authored.** The Former is the eighteenth, and there
is room for six more.

### The margin rule still applies

`output_qty × output.base_price ≥ 1.4 × Σ(input_qty × input.base_price)`, per
[docs/production.md](production.md). It has to be checked on every new recipe
here, and the reason it is easy to forget is the reason production.md gives: a
recipe that loses money looks exactly like one that makes money, and the shop
cheerfully runs it all day.

Note that this **adds a hop** to every meat chain — biomass, then a cut, then
whatever the kitchen does with it. Depth is capped at three in production.md and
`beef → mince → bolognese` was already two. Check that nothing lands at five.

### …and three things DO land at five, deliberately

Measured over the whole catalogue once the loop was closed: 78 recipes, all of
them clearing 1.4×, and the deepest chain is **5** on exactly three items —
`frozen-pizza`, `jam-tart` and `mince-pies`. Every one of them is downstream of
milk, and the cause is the one recipe that closes the dairy half:

```
dairy-culture ─[Churn]→ milk ─[Churn]→ cream ─[Churn]→ butter ─[Mixer]→ pastry ─[Oven]→ mince-pies
```

The meat side is fine — the Former makes finished cuts straight out of biomass,
so `protein-biomass → mince` is one hop and nothing there moved. It is the
*dairy* chain that was already at four before this document existed
(`milk → cream → butter → pastry → jam-tart`), and putting a vat in front of
milk is what takes it over.

**It was shipped anyway, and that is a decision rather than an oversight.** Two
reasons. The five-hop chain is never *forced*: the van sells everything again
(docs/production.md's closed fork), so milk, butter and cheese can all be
bought, and every intermediate on the way is sellable in its own right — the
player who wants a mince pie has a one-hop route to it and the five-hop one is
the margin play. And the alternative is worse: without this recipe the Culture
Tank's output feeds only one thing, and retiring the Dairy Shed puts milk back
to being bought, which is the exact sentence production.md calls *"the single
oddest thing in the catalogue"*.

The fix that was rejected is worth recording because it looks like the obvious
one. A second Churn recipe — `dairy-culture → cream`, skipping milk — pulls
`jam-tart` and `mince-pies` back to four and leaves `frozen-pizza` at five (it
goes via `milk → curd → cheese → pizza`), so it would take a *third* shortcut to
actually hold the line. At that point the recipes exist to move a number rather
than because anybody wants to make cream that way, which is authoring content to
game a guideline. **Three is a shape, not a rule**; production.md says
"occasionally four where it is the joke", and this is five on three bakery items
nobody is obliged to make from scratch. If a later step wants the ceiling back,
the honest lever is the dairy chain's own length — `milk → cream → butter` is
three hops on one machine — and not a bypass round it.

---

## Step 4 — the racks, and the one real balance change

Crops survive completely. Sow, wait, harvest is the rhythm the player likes and
the one the plot exists for. The bed becomes a rack, the soil becomes a tray, the
stages draw under lights instead of under sky, and **not one crop row changes**.

Except one field, and it is not small.

### …and then the rack STOOD UP, which was three changes rather than a reskin

Built after the rest of this document, and worth its own heading because two of
the three move rules rather than pictures.

**It blocks its cell.** `plot` was `blocks: false, rotates: false, anchor: null`
and every word of that was right about soil: you stood ON the thing you were
picking, so it had no working spot because it *was* one, it could not turn
because a square of earth has no front, and a block of them was a field you
walked through. A grow tent has a front and a door, and a waist-high tent you
stroll through is the thing that reads wrong. So it takes the shelf's shape —
`blocks: true`, `rotates: true`, `anchor: 'useAt'`, `ends: true` — while keeping
`ground: T.PLOT`, which is still what refuses a second rack on the cell and what
`canPaintGround` reads to say "there is a bed there".

Two things fell out that were not obvious:

- **The generator had to grow aisles.** `PLOT_PITCH` was 1 and a farm was a
  packed square, which the day plots blocked became a solid block with an
  unreachable middle — nine plots is a 3×3 whose centre has no side to stand on,
  `canPlaceCleanly` refuses it and the generator reports `incomplete`. It is two
  numbers now, `PLOT_COL_PITCH` 1 and `PLOT_ROW_PITCH` 2, which is
  `SHELF_ROW_PITCH`/`ROW_PITCH` exactly: touching along the row, an aisle between
  rows. A grow room is racks and aisles. No live save was stranded — every
  existing farm is 4–5 beds in a 2–3 wide block, so every one of them is already
  on a perimeter.
- **Upgrading a bed had never worked, and nothing said so.** `canPlace` asks two
  questions — what the ground is made of, and whether anything stands on it —
  and only the second had ever heard of `ignoreId`. A `plot` stamps `T.PLOT` and
  that is in neither buildable set, deliberately, so a rack asked to stand where
  it already stands was refused **by its own stamp**, with the message that the
  cell was occupied. `upgradeFixture` goes through `repositionFixture`, which
  re-judges the placement, so the Lit Rack rung has been unbuyable for as long as
  it has existed. The belt half of the same bug was papered over years earlier by
  `conveyorSwap`, which is a bespoke function about conveyors that happens to
  return before the tile test; the general rule it is a special case of now lives
  beside it, and a stamp you made is proof you were allowed to build here.

**Picking is a press.** The bed was the one goods job in the game on proximity —
`auto` on the candidate, fired by standing on it — and the whole argument for
that was *the tile under your feet names exactly one bed*. A rack cannot be stood
on, so `standingOn` is false for every plot for ever and the branch could only
have been dead code reading as a live rule. It is gone; you point, you walk, you
hold, which is what taking an armful off a shelf already was. `verify:build`
asserts the inversion rather than dropping the claims, because a gesture that
quietly went back to firing on its own would strip a grow room as you walked down
the aisle and would look exactly like a farm working.

**The rung buys DECKS.** `capacity_mult` 1 / 2 / 3, multiplied into `sowInto` —
the one place a yield is decided, and the same choke point that exists so the
bed *draws* what it is going to give. `speed_mult` was flattened to 1 in the same
breath, or the two compound to 6.9× at the top rung for $260. The art carries the
count rather than the code: a stage's `surface` parts ARE its decks
(`surfacesAt`, the shelf's own flag), so a rung that draws the wrong number of
trays says so on screen. `clearanceOn` (shared/model.js) is the new half — a
tray in a rack has a grow light a third of a tile over it, and the crop catalogue
was authored for open sky, so a plant is scaled to fit under its own light.

⚠️ **The deck ladder is a supply increase and `simulate` can see it**, exactly as
the seasons change below is. It has not been measured.

### All fourteen crops are seasonal

```
apple-trees, berry-canes, carrot-row, chilli-row, flower-bed, groundnut-row,
kale-patch, lettuce-bed, mustard-row, pea-row, potato-patch, sugar-beet-row,
tomato-vine, wheat-field
```

Every one carries a `seasons` array, and three sites refuse to grow out of season
([index.js:9182](../server/sim/index.js#L9182), 9211, 9668) with a fourth filtering
the seed list (17057). Indoors that fiction breaks: a controlled environment has
no winter.

**Seasons are two separate mechanisms and only one should go.**

| | Field | What it does | Verdict |
|---|---|---|---|
| Demand | the item's `season` tag | `seasonMult` 1.35 in / 0.75 out, feeding `suggestedPrice`, `wholesalePrice` and `purchaseChance` ([economy.js:229](../server/sim/economy.js#L229)) | **keep** |
| Supply | the crop's `seasons` | whether it grows at all | **drop** |

Shoppers wanting berries in summer is a fact about the town. A field that cannot
grow them in March is a fact about the weather, and you have just spent money on
a building with no weather in it.

What that buys is the good version of the mechanic: **prices still swing, and now
you can supply the swing.** Going indoors buys you the 1.35 peak instead of
locking you out of it.

### ⚠️ This one is measurable, and it must be measured

Unlike almost everything in this document, `simulate` **can see this**. The
balance bot plants crops. It never places a pen and never runs an appliance —
[docs/production.md](production.md) and [docs/pens.md](pens.md) both say so — but
the crop half is squarely in the instrument's view.

Fourteen crops becoming year-round is a supply increase across the whole farm.
Run it properly, per CLAUDE.md: `clear_modifiers` first, check `startedWith` and
`startedWith.difficulty` match, same seeds either side, and **average over ten**
— one seed is not a measurement, and this repo has a −14%/+7.8% story about
exactly that.

The honest expectation is that it is a buff and needs paying for somewhere. The
cheapest lever is the vat and rack prices, not the crop numbers, because crop
numbers ripple into 68 recipes.

---

## Step 5 — the culture floor, and what stands on it

`GROUND.paddock` → `GROUND.culture`. Same brush, same `pad: true`, same
`PEN_CELLS_PER_HEAD = 4` ([index.js:958](../server/sim/index.js#L958)), same
`paddockOf` flood, same division between machines sharing it, same
`clamp(cells / 4 / sharing, 1, tier.heads)`.

**It is not pasture and it must not be deleted.** It is the only thing in the
feature that makes floor space cost something: paint more deck and a vat runs
more lines, up to the ceiling its rung allows. Delete it and a vat is a tier
ladder with no land behind it, which is the half [docs/pens.md](pens.md) argues
against at length. It reads *better* indoors than out — a warehouse rationing
square footage is a real constraint where an acre of grass was an arbitrary one.

Only the label, the colour and the `does` string change.

### The one thing here that is actually code

The paddock was legible because **six pigs meant six head**. You could read the
number off the floor without a menu. Paint with nothing on it is a number nobody
can see, which is the `charm` trap: a working system with no content in it is
indistinguishable from a broken one.

`body` is a walker. `stepAnimal` steps one cell at a time, four-connected, and
the four-connected part is not a detail — it is the fix for the 122 strays
`verify:pens` caught on its first run, because a leg is a straight line and an
L-shaped field has cells the straight line goes through. Anything that uses
`body` inherits that, and anything that **stands still** is using a movement
system to draw statues.

So it is two things, and they are different:

- **Culture trays — the count.** One per line, glowing as the batch fills. This
  is what six pigs were doing, and it is what the player reads. Trays do not
  walk, so `body` needs a "stand still" mode: place N copies at hashed cells and
  never call `stepAnimal`. That is the new code, and it is small.
- **A tender drone — the life.** One per vat, walking the deck. `body` already
  does this exactly, unchanged, quarter-turn and all.

Two things about the trays fall straight out of pens.md and must not be
relitigated: they come out of `hash01` and **never `this.rng`** (a draw would
move every basket, crop and spawn roll after it, and two `simulate` runs either
side of authoring a tray would diverge with nothing to say why), and they live on
`Game.animals` **in memory, off the layout record** — a re-flow rebuilds the
record, and build mode re-flows on every wall segment, so trays filed there would
snap home on every drag. That is `parkNow`'s bug, and this document would be
re-finding it.

`body: null` is already legal and already shipped — the beehive has it — so a vat
nobody has drawn a tray for runs exactly as many lines as one somebody has and
draws none of them. That is what keeps this a look.

### What was built: `bodies`, a list

**Built.** `body` did not gain a flag — it gained a plural. A `fixtures` row may
carry `bodies: [{ model, roams, per }]`, and `bodiesOf` (shared/pieces.js) is the
one reader, which resolves the old `body` column as a list of one. Three things
about the shape.

**The two fields are not a rename of each other**, which is `heads` against
`capacity_mult` again. `roams` is whether it moves and `per` is how many there
are, and all four combinations mean something: a herd (roams, per head — every
pen ever authored), a rack (still, per head), a tender (roams, per pen), a statue.
The tempting fold — *a thing that stands still is the count and a thing that moves
is the life* — takes the pigs away from being the count, which is the one thing
about them that was load-bearing.

**A stander is DEALT a cell, never handed a hashed one.** A roamer only has to
start somewhere legal because it walks off; a stander is where it started for the
life of the save, so two of them on one square is a vat running six lines you can
count five of — which reads as the arithmetic being wrong when it is the
placement, and is the exact failure the trays exist to prevent. `penField` carries
`share` and `sharing`, so the deal steps on per shelter and per body and is
provably disjoint both ways, with no claim list anywhere. Hashing instead was run
as a deliberate mutation: **8 trays, 7 squares**, on the first field it was tried
on.

**A stander needs DECK to stand on**, which is the second control and was found
from a screenshot rather than reasoned about. `penField` falls back to the
machine's own two-by-two when nothing is painted round it — right for a roamer,
and where the hen with no paddock has always milled about — and a tray dealt one
of those squares is drawn *inside* the vat. That is every vat in the shop the day
it is built, so the trays would have read as broken until somebody happened to
paint a deck: the trap this step exists to close, arriving through the default.
So a rack turns up when there is somewhere to rack it, and the tender is what
keeps an unpainted vat from being a machine with nothing on it.

**It is `qty / cap` and never `penFill`.** A tray is drawn in stages on how much
is standing READY. `penFill` is how far through the batch now brewing and answers
0 when the pen is full — deliberately, and for a good reason of its own — so a
tray staged on it empties itself at the exact moment the vat is fullest. Art
running backwards, on the one machine the shop is telling you to go and empty.

The other half of the shape is why `bodies` is a second column rather than a new
value in `body`. Content here is edited **live**, from a second window, against
whatever server happens to be running — which is very often not the build you just
changed. A column that gains a new *shape* is mis-read by every reader that
predates it; a column that simply did not exist is invisible to them. And every
pen row in every save carries a bare model in `body`, so a shape change is a
rewrite of all of them for nothing. Same call `kindOf` makes about a row written
before there were kinds: a read-time default, not a migration.

---

## What it costs

The code is a day. **The art is the project**, and it should be said in one place
rather than discovered:

| | |
|---|---|
| Vat models (+ `work` stages) | 3 |
| Former model + `work` | 1 |
| Grow rack, at every crop stage | 14 crops × stages |
| Trays and a drone | 2 |
| Retired | 7 pen models, 5 of which are mostly fence |

[docs/production.md](production.md) already warns that eight of the eleven
original appliances shipped with **no** `work` art and draw a Domestic machine
when you have paid for Commercial. Do not add to that pile: a machine that cannot
be seen working is a machine you cannot tell is on, and that is the whole reason
`work` exists.

The [props skill](../.claude/skills) applies to every one of these — in
particular the luminance floor, because a vat is the exact shape that wants to be
dark steel and the ink pass has nothing to lay a line on below 0.20. `CONVEYOR.frame`
already learned that the hard way.

---

## The traps

**A fixture's footprint proportion did not travel indoors, and nothing said so.**
The pen convention is to nearly fill the 2×2: shipped `dairy-shed` spans −0.95 of
a block whose edge is −1.0, which is 0.05 of clearance, and the three vats were
authored to the same proportion because matching the family is the right instinct.
It reads as overhang the moment the machine is indoors, and the cause is not the
model at all — **grass has no drawn grid and the shop floor does.** The identical
proportion that looked correct on a lawn for the whole life of docs/pens.md looks
like a machine sitting over the tile line on lino. Nothing in the art changed;
what changed is that there is now a ruled surface behind it to be measured
against.

Two things follow. A fixture that fills its cell wants roughly the **shelf's**
ratio indoors — ±0.34 in a 1.0 tile, about 70% — rather than the pen's 95%. And
this will bite the **grow racks** in step 4 exactly the same way, for exactly the
same reason, so decide the indoor proportion once and apply it to both. The
general shape is this repo's most common one: *a convention that was correct
because of the context it lived in stops being correct when the thing moves, and
the code that expressed it does not look wrong afterwards.*

**Rewire, never delete-and-recreate.** production.md's own trap, and it bites
hardest here because the pens are live in real shops. Editing a `fixtures` row's
`produces` keeps every placement; deleting the row makes `pieceFor` fall through
to `defaultPiece` and every vat in every save becomes a shipped pen — which fails
silently and looks like art. If an item is retired rather than rewired,
`binOrphans` gives it one day of grace and then the stock is gone.

**…which left "retire" with nothing in the codebase to say it, so it grew a
table.** `computeBuildTools` listed every `fixtures` row of a kind
unconditionally, and there was no per-piece way to stop offering one:
`shared/reveal.js` is keyed kind-first (`REVEAL.pen` is already
`first-harvest`, so a per-piece entry there would never be read at all), only
ever hides a button *until a rung lands*, and `verify:reveal` rejects a gate
that does not name a real milestone — there is no rung for never. Pricing them
out is worse than useless: `razeFixture` refunds `cost × FIXTURE_REFUND`, so a
pen repriced to 100000 lets a live shop sell the ones it already owns back at
50,000 each, and the button stays on the bar regardless. And rewiring their
`produces` to a biomass — the tempting content-only answer — silently stops a
running shop's egg boards being fed while a pile of biomass grows on its pad,
which is the one option that fails while everything reads as working.

So `RETIRED_PIECES` sits beside `REVEAL` as its opposite promise: a gate hides a
button you have not reached, this takes away one you have gone past. It is a
palette FILTER and never a permission — `placeFixture` has never heard of either
table — and it is the same call `RETIRED` in `client/sections.js` already makes
about the `staff` and `space` upgrade kinds, one table over and keyed on the
piece instead of the kind. The seven rows stay exactly where they are, art,
ladder, price, `produces` and refund intact. `verify:reveal` §8 is the sweep, and
its claim is a pair worthless split in half: off the bar **and** still resolving
through `pieceFor`, because "off the bar" alone is satisfied by deleting the row,
which is the thing this exists so that nobody does.

**`poultry` has no category tag.** Found while sizing this: its tags are
`needs-freezer, perishable, heavy` — no `meat`, no `dinner`. So no
meat-affinity shopper has ever had an opinion about it, and it has been quietly
weaker than pork and beef since it was authored. Nothing logs it. It is dead
stock wearing a working item, and since step 3 rewrites the meat aisle anyway,
fix it on the way past. `list_tags` before authoring anything, as ever.

**`organic` is a live tag with affinities behind it.** If everything is
vat-grown, decide what the word means before authoring, or it becomes a tag that
sells well and says nothing. The obvious answer is that it becomes the premium
line rather than the default one.

**The outdoors does not go away.** The van drives, shoppers park, the road and
the pavement steer them, and the border ring is the road round the outside — you
may paint it, and no amount of paint out there steers anybody. What ends is the
*farm* being outdoors. The field the generator lays down (`FRONT_DEPTH`) becomes
floor you may build on, which is the expansion space this shop has never had.

**`verify:pens` is the acceptance test.** A rename should pass it nearly whole.
Its control — a pen with no `produces` never fills, and a shop that never bought
one has an empty list — is what proves the reskin changed no rule. If it needs
edits beyond strings, something in the rename was a mechanism.

---

## What is deliberately not done

- **No new kind.** `pen` stays `pen` in the code, ids and enums untouched, per
  CLAUDE.md's rebrand rule: the player reads "vat", the database reads `pen`, and
  the trap to avoid is somebody "fixing" the mismatch later.
- **Nothing feeds the vats.** pens.md's argument is unchanged — an input hopper
  is a second way for the farm to jam, and it is a bigger decision than it looks.
  The printer eats biomass; the vat still produces out of nothing, which is the
  same bargain a crop strikes about soil.
- **No power.** [docs/belts.md](belts.md) step 6, still last, still because it
  re-prices every appliance in the game. A grow rack under lights is the most
  tempting possible argument for it and it should still wait.
- **No outdoor removal.** Existing farms keep working (`where: 'any'`), the
  paddock keeps its behaviour under a new name, and nothing migrates.

---

## Build order

1. **The two flags** — `where: 'any'` on `plot` and `pen`. Playable immediately:
   an indoor farm with the old art, which is worth looking at before drawing
   anything.
2. **The floor** — rename `paddock`, recolour it. No behaviour.
3. **The vats** — three `fixtures` rows, three biomass items. The seven pens stay
   authored until step 4 lands, so nothing breaks in a running shop.
4. **The Former** — one station variant, four recipes, margin checked. Retire the
   pens by rewiring, not deleting.
5. **Seasons** — drop the crop-side field. **Measure this one**, ten seeds, both
   arms against one frozen world via `SNS_DB`.
6. **The art** — the long pole, and the only part that cannot be done in an
   afternoon.
7. **Trays** — the standing-still `body`. Last, because until the vats are drawn
   there is nothing to stand them next to. **Built**, as `bodies` — see the
   section above, and `verify:pens` §12, which is the sweep that ships with it.

Steps 2–5 are content and flags and land through `POST /api/content/:kind`, so
two people can work at once and no file is touched. Steps 1 and 7 are the only
code in the document.
