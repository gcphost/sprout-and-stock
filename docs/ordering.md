# Ordering — what the shop buys, and who decided

Status: **steps 1–10 built.** The restocker counts what the shop can already
supply itself before it spends money, the three decisions it used to make
silently are switches in the supplier, every item can carry a standing order,
a shelf's own menu will now tell you what is on the van and order more,
deciding what a board is *for* has a shortlist and a stock count of its own,
the shop keeps a thing in one place, a unit marked for the back is stocked
for the appliances beside it rather than for the shop front, seven tabs became
three verbs, an item has a menu of its own — where what you charge for it is
a fact about the shop rather than about each board it stands on — and an order
is a thing you can place twice, at whatever size you meant.

⚠️ Both built steps measure as **balance-neutral at their defaults**, and that
is deliberate rather than lucky. Step 1 came out at +2.7% mean profit over ten
seeds against a frozen world — inside the noise floor CLAUDE.md documents, and
6/10 seeds went the right way, so the number to believe is the spoilage one
(−5.6%, 7/10 seeds) and shelves-found-empty (61.6 → 46.5). Step 2's default is
`budget: null`, which means "no cap" rather than "zero", and ten seeds came back
**byte-identical** to the run before it.

The goal: the shop should not buy what it already has, and everything it does
buy without asking should be something you could have told it not to.

---

## What this is about

Restocking is one function — `restock` in [server/sim/staff.js](../server/sim/staff.js)
— and one rule about the shop it reads from, `Game.restockQueue`. The split is
deliberate and predates all of this: *which shelf wants a van* is a fact about
the shop and lives on `Game`, because it is what the player set in the shelf
menu; *how a worker acts on it* is the job and lives in `staff.js`. A second
copy of the queue rule inside the job is the one that would quietly disagree
with the menu describing it.

Everything below hangs off those two.

---

## Step 1 — the shop knows what it already has ✅

### What was wrong

`restock` looked at shelves and at nothing else. Its one nod to stock already in
the building was this:

```js
if (game.deliveries.some((d) => shelfFor(game, d.item_id, c))) return false;
```

which reads as a supply check and is not one. It answers *what should I do next
tick* — unload the pallet rather than order another — and says nothing about
**how much to order** once there is no pallet in the way. Two consequences, and
neither of them looks like a bug from inside the game:

- **A reservation is an instruction to buy.** A board you ticked and have not
  filled sorts to the *front* of `restockQueue`, ahead of every merely-thin
  shelf. That is right — otherwise ticking a third thing onto a well-stocked
  unit would never be acted on. But it means stripping a shelf you had reserved
  makes it read as bare-and-asked-for, and the shop buys a full unit's worth.
  Observed on a real save: 28 carrots stripped into crates at 0.33–0.44, two
  vans of carrots ordered at 0.62 and 0.75, the crates sitting two tiles away
  the whole time.

- **The farm competed with the shop.** Nothing connected `crops.item_id` to what
  the shop was ordering, so a player with four beds of carrots bought carrots at
  wholesale forever, and their own harvest had nowhere to go — which presents as
  the *farm* being pointless rather than as the ordering being wrong.

### What it does now

`Game.homeSupply(itemId)` counts everything the shop could shelve without paying
for it: crates on the floor, armfuls in hand, and the beds. `restock` subtracts
it from the board's room before ordering, and — this is the half that is easy to
miss — before *choosing* which reserved board to fill:

```js
const buy = (id) => Math.max(0, need(id) - game.homeSupply(id));
```

Sorting the reservations on `need` rather than `buy` would put the emptier board
first and buy the thing already on its way in. A shelf kept for carrot and bread
with a field of carrots outside should order the bread.

Three things about it are worth keeping:

**A growing bed counts in proportion to how grown it is**, not by a ripe/unripe
cutoff. A cutoff is a threshold nobody can see, and it would order a full shelf
of carrots six seconds before the harvest lands. Scaling by `plotGrowth` means a
crop authored at 600 minutes contributes nothing early, which is correct — a
shelf held empty against a promise that far off is just a bare shelf.

**It is charged per board**, not against the shop's whole holding of the item.
That under-orders slightly when one crate could serve two shelves. It is the
safe direction: the next pass re-reads it once the crate has landed, and the
other way round is the bug this replaced.

**The player's own crates count.** That is the case that started this, and it is
why `homeSupply` reads `deliveries` rather than only the farm.

---

## Step 2 — the three decisions become switches ✅

### What was wrong

The only limits on a stocker's spending were `CASH_FLOOR` ($15) and
`SPEND_FRACTION` (0.3) in `staff.js`. Both are sensible and neither is *yours*:
nothing on screen said they existed and nothing could change them, so the answer
to "stop buying that" was to fire the hire.

### What it does now

`Game.orders` — persisted, on the save, in the snapshot, and drawn as one strip
of three squares at the top of the supplier:

| Field | Default | What it governs |
|---|---|---|
| `auto` | `true` | Whether staff order at all. |
| `assign` | `true` | Whether the shop picks what goes on a shelf you have not reserved. |
| `budget` | `null` | Ceiling on what the **staff** may spend on stock per day. |

**`auto` off is not "staff off".** They still unload, shelve and tidy — a shop
that has stopped buying still has to put away what is in it. Only `restock`
checks the flag.

**`assign` is narrower than it sounds, and the line matters.** It gates
`pickItem` — the shop choosing what your *range* should be — and nothing else.
It deliberately does **not** stop a stocker putting an armful onto a bare shelf:
that is tidying goods you already paid for, and refusing it would strand your own
deliveries on the floor forever. Reserved boards and top-ups of boards that
already hold something are unaffected, because you put those there.

**`budget` is a second ceiling, not a replacement.** The lower of the two wins:

```js
const budget = Math.min(
  (game.cash - CASH_FLOOR) * SPEND_FRACTION,
  game.orderBudgetLeft(),
);
```

A cap of $500 must still not spend the last $20 in the till, and a rich shop must
still stop at the cap.

Two details that are not obvious:

**Only staff spending counts.** The player buying six of something out of the
supplier panel never touches the counter. A cap you set on yourself is a cap you
would spend the game raising.

**The daily reset is lazy, in `staffSpentToday()`, not in `onNewDay`.** Same
argument `lastDirectorDay` makes about claiming its guard synchronously: a
counter cleared by exactly one code path is wrong every time the day changes
some *other* way — a save loaded on a later day, a `set_time` jump, a sixty-day
balance run. Asking "is this counter about the day we are actually in" at the
moment of reading cannot miss any of them.

And `simulate`'s `startedWith` reports the settings, for the reason it reports
`ownedUpgrades`: a shop whose owner switched ordering off is a shop whose staff
stop restocking, and every number in the result would move without a word about
why.

---

## Step 3 — a standing order per item ✅

This was argued for on the shelf first, and that was the wrong call. The
argument was that "how full should this be" already has two answers living on
the shelf — the reservation says *what*, `RESTOCK_FRACTION` says *when* — so a
third opinion elsewhere would disagree with them.

It only disagrees if it is measured in the same units, and it is not. **A rule
is about the shop; a shelf is about a board.** "Keep 5 eggs, never more than 20"
is a sentence no shelf can say — a shop with three egg shelves would mean it
three times over — and it is the sentence a shopkeeper actually has in mind. The
shelf still decides where a case goes and how much of that unit it may take. The
rule decides how many you want to own. Nothing overlaps.

`Game.orders.items[itemId]`, all three fields optional, none of them stored
unless you set one:

| Field | Means | Reads it |
|---|---|---|
| `auto: false` | Staff never order this. | `restock`'s `buy`, **and** `pickItem` |
| `min` | Keep at least this many in the shop. | `restockQueue`'s `ratio` |
| `max` | Never hold more than this many. | `restock`'s `buy` |

Four things worth keeping:

**`auto: false` has to bite in two places.** Bounding the quantity alone means
the shop keeps *choosing* a banned item for every bare shelf, ordering zero, and
quietly never stocking that shelf with anything else either — a ban that reads
as the shop breaking. `pickItem` filters it out of the candidates as well.

**`min` can only pull a van forward, never hold one back.** `ratio` takes the
lower of the board's own line and the shop's holding against `min`, so an item
nobody has said anything about behaves exactly as it did. That is what keeps
this balance-neutral by default.

**`max` is checked against every board plus what is already coming in**, not
against the unit being filled — otherwise a max of 4 would let each of six
shelves hold 4 and the shop would end up with 24. The sweep asserts precisely
this, because a per-board reading passes every single-shelf test.

**A max under a min gives way to whichever you just moved.** Otherwise the shop
sits forever below a floor it is not allowed to reach, and nothing says why.

### On measuring it

Balance-neutral at defaults, and the proof is a **bisect rather than a
before/after**: both hunks reverted and both hunks in place, measured minutes
apart, give byte-identical results on three seeds. That is the only honest
control available here — `server/sim/index.js` is being edited by the other
person's agent at the same time, so a run from an hour ago and a run from now
differ for reasons that have nothing to do with this. CLAUDE.md says to take the
*world* out of a comparison with a frozen database; when two people share a
repo, you have to take the *code* out of it too, and the way to do that is to
flip your own change back and forth inside one minute.

A `min`/`max` somebody actually sets is a different matter and should be
expected to move the numbers — a `max` below capacity is the first thing in the
game that makes a shop deliberately hold less stock than it can.

---

## Step 4 — ordering from where the question occurs to you ✅

Everything above is decided in the supplier: a panel you open from the rail,
sorted by item, that answers "should I buy eggs". None of it is where you are
standing when the question actually arrives, which is in front of a bare shelf
with its menu open.

Three things moved onto the board rows in the fixture menu. No new state and no
new verb — every one of them is a fact the server already sends and a message
that already existed.

**What is on a van, on the board itself.** `+6` in green, hung off the board's
count exactly the way the supplier hangs it off the shelf count, with the hour
in the tooltip. This is the only fact about a board you cannot get by walking
over and looking at it — a shelf you can see, an order you cannot — so the shelf
saying "4" while six are on a lorry is the panel telling you half of it.

**An order button per board.** It asks for the room on *that board* less what is
already coming, clamped to what the bay will still take. Subtracting the van is
the same rule `restock` works to, moved onto a control with a player's finger on
it: without it, the button under a bare shelf is the "shelf reads as bare, order
another case" bug in a shape you can press twice. When there is nothing sensible
to ask for it disables and the tooltip is a sentence — "6 already on the way",
"this board is full", "no room at the bay for another order" — because a greyed
button that never says why is the thing that reads as broken.

**And the "Waiting for" line says whether the van is real.** A reservation with
nothing on order and one with six arriving at 14:00 are opposite situations —
one of them is a job to do — and the line said the same words for both.

Two notes on the shape:

**`comingByItem`/`comingWhy` moved to `client/orders.js`.** They were private to
the supplier. What is on a van is a fact about the world rather than about a
panel, and it has two readers now; a second spelling of the fold is how the
shelf ends up saying six while the supplier says twelve, because one of them
counted the lorry and the other didn't.

**The button is not gated on build mode and not on standing anywhere.** Ordering
is shopkeeping, the goods land at the bay whatever you do next, and every
refusal the server can give already arrives as a toast. It is the one control on
the row that goes straight out — Take is gated on reach, and Delete rides
`build-empty`'s build-mode gate.

---

## Step 5 — deciding what a board is for ✅

Step 4 answered "how do I fill this board". This is the question one step
earlier, and it is the one the panel was worst at: **what should this board be
for.** *Keep it for* is every item in the catalogue, alphabetically, and it gets
one row longer every time anybody authors a tomato. There is no wrong answer in
it and no fast one either.

**A stock count on every row.** The same column the supplier grew in step 3, in
the same two shapes — a dash for none, `+6` in green for what is on a van. The
list was a catalogue for exactly the reason the supplier was: you cannot decide
what a shelf should hold without knowing what you have got.

It counts more than the supplier's does, and that is the one thing here worth
remembering. Over there `held` is stock **on the boards**, because the question
is whether a shelf is running thin and a crate in the yard has not filled
anything. Here it is boards **plus crates plus hands**, because the question is
what to commit a board to and a crate on the pad is the best answer there is —
it is already bought. Two questions, two functions (`ui.heldOf`, `ui.spareOf`),
both on the HUD so neither panel keeps its own spelling of "how many have I
got". Where the number came from is on the sub-line whenever any of it is in
crates, since that is the half you cannot see from the shop floor.

**Quick pick, in front of the full list.** Six rows — deliberately under the
eight a search box appears at, because a shortlist that grew one would have
grown the exact control it exists to save you — alternating between two
questions that have different answers: *what sells* — today's own till first,
then the world's appetite, then the sticker price, because the day resets at
midnight and a shop that has sold nothing still has to answer — and *what you
already have*, most first, nothing with none. Interleaved rather than
concatenated, so the tab is not the good half followed by the other one, and
every row says which half put it there.

They are the *same rows* as the full list, filtered and copied — ticking one
does exactly what ticking it below does, because a second row builder for one
checkbox is a second set of rules about what may go where.

**...and under the tabs, the aisle** (`deptStrip`). The catalogue is long and
the search box only helps when you already know the name of the thing you want.
That is the wrong assumption about how anybody arrives here: what sends you to a
shelf is the demand meter saying *produce is short*, so the question is "show me
produce", and there was no way to ask it.

Three things about the strip:

- **The departments are `DEPARTMENTS`, in the meter's own order.** It is the
  same twelve buckets drawn in `client/hud-meters.js`, and two readouts of one
  set in two orders is two things to learn.
- **Only the aisles this list has rows in.** The icon tabs above deliberately
  draw empty tabs — they are a fixed shape you learn — and this must not, because
  a freezer's departments are a property of the list rather than of the menu.
- **Text, not icons.** There is no picture of "condiment", and inventing twelve
  is twelve glyphs to learn for words that are already written down the side of
  the meter. It also wraps rather than scrolling: a strip you scroll hides the
  aisle you came for, and with words there is no "further right" to predict.

Note this is *not* the split the crate/appliance icon deliberately avoided.
Splitting the list by where a thing comes from means knowing the answer before
you can look it up; splitting it by department means being handed the question
by the meter that sent you.

**And the three settings tabs became one.** *When it gets refilled*, *The shop
hand* and *Set up* were three tabs holding seven rows between them. A tab is a
place you learn to look, and every one you add makes the rest narrower on a
214px panel — three of them meant the thing you wanted was behind whichever
pictogram you did not try first. One **Settings** tab, three `sep` headings, in
the order you would read them: how it gets filled, who may touch it, what it is.

---

## Step 6 — one place per thing ✅

### What was wrong

Everything above bounds *how much* the shop buys. Nothing bounded **how many
boards it buys it for**, and that turns out to be the same bug wearing a shape
nobody was looking at.

`shelvesFor` ranked the unit an item was already on first, and that is a
preference rather than a rule — it stops meaning anything the moment that unit
is full. One armful of overflow claims a bare board on the unit next door, and
from that tick the shop has two homes for one thing. It does not settle, it
compounds:

- each board is its own line in `restockQueue`, so the shop now buys for both;
- `pickItem`'s old `?? scored[0]` fallback made it worse *deliberately* — with
  every item that fits a unit already stocked somewhere, the function whose
  whole job is choosing the range chose a second board of the best seller;
- and neither board could ever be given back. `releaseBoards` protects an empty
  board while `homeSupply` is above zero, which for anything you farm is for
  ever — a shop with two tomato beds could not age a spare tomato board a single
  day.

Observed on a real save at day 10: tomato on three units, chocolate on two,
carrot split 15/14, soda split 22/7, and four shelves of produce the owner never
asked for. What it reads as is staff being stupid, because every individual
decision in that chain is a worker correctly putting goods on a shelf with room.

### What it does now

`Game.homeShelves(itemId)` — the shop's own answer to *where do we keep this*,
on `Game` for the reason `restockQueue` is, and `shelvesFor` refuses every other
unit. Three things decide it and none of them is this function:

| | |
|---|---|
| `assigned` | Every unit you ticked is a home. That is the override for "I want soda in two aisles". |
| the stock | Otherwise the unit holding the most of it wins, and the others stop being restocked and drain. |
| `boh` | Each side is homed separately — a stockroom unit backing up the floor is the one second place that is the point. |

Four notes:

**Consolidating by not filling needs no job and no walk.** The losing board is
simply never chosen again, sells down, and `releaseBoards` hands it back — which
is why that function had to learn about homes *before* its supply guard rather
than after. The shop hand's Merge still walks a live board over when somebody is
employed to do it; this works in a shop with one clerk, which is most shops.

**Overflow goes to the pad, not to the next unit.** That is the whole change,
said from the goods' point of view: `unload` already walks a crate nothing will
take back to the drop-off, and `restock` stops ordering more because `buy` asks
the same question. Goods are never destroyed and never stranded anywhere new.

**Your own hands never read it.** `boardFor` and `shelfAccepts` are untouched,
which is the line `orders.assign` and `giveUpBoard` already draw twice: the
shop's judgement about its own range was never a rule about what you may do.

**`pickItem` answers null now instead of the best seller.** A bare unit with
nothing new to put on it is a shop with room to grow. Left as it was, it would
order a second board's worth of the winner and the goods would ride the lorry
straight to the pad.

`verify:yard`'s three-porter section had to be re-pointed at three *ticked*
units, and that is worth knowing before writing the next sweep: "every shelf is
bare, so every shelf is legal" stopped being true for a single item, and a
reservation is now the shortest way to author a shop where two boards will take
the same goods.

---

## Step 7 — a stockroom is the kitchen's larder ✅

### What was wrong

Marking a unit **In the back** does three things: shoppers stop seeing it
(`chooseShelf` filters it, `stockedForTag` stops counting it as having any), the
chef fills a whole hopper off it rather than borrowing one batch, and each side
is homed separately so it can back the floor up.

Nothing told the *buyer*. `pickItem` chose a range for a bare back-room board
exactly the way it chooses one for the shop front — best margin × how much the
archetypes want it — which is a question about people who are never going to
walk in there. So a stockroom filled with whatever sells well out front, and
every unit of it was dead on arrival: no shopper can see it, no machine can use
it, and it is holding a board, which is [the scarce thing](#step-6--one-place-per-thing-).
`restock` then went on topping those boards up for ever, because `buy` asked
`homedAt` and `homedAt` was perfectly happy.

It reads as a stockroom that does not work, and every individual decision in it
is the shop correctly buying a well-chosen item for a shelf with room.

### What it does now

`Game.larderRanges()` — which machines each stockroom unit is the larder *for* —
and `Game.backRoomTakes(shelf, itemId)` on top of it. Three callers, and they are
the three halves of the same sentence:

| | |
|---|---|
| `pickItem` | Choosing the range for a bare back-room board: candidates are that unit's larder, and nothing else. |
| `shelvesFor` | Where an armful may be walked. A stockroom is not a home for goods its machines cannot use, so overflow goes to the pad as it does for [any other item with nowhere to go](#step-6--one-place-per-thing-). |
| `restock`'s `buy` | The half that spends money. Asked separately, or a board that already holds the wrong thing is topped up for ever. |

Five notes:

**It is per unit, not per shop.** One set for the whole building is right with
one kitchen and wrong the moment there are two: a coffee corner out front and a
fryer in the back both wanted their ingredients, so every larder ordered both and
each kept half a room of stock its own machines could not use — the original
complaint again at one remove, and worse the more you build. So **every machine
is served by the larder nearest it**, and a larder no machine picked stocks for
the machine nearest *it*. The second half is the one that is easy to leave out:
without it a second unit in the same room as the first is chosen by nothing and
takes nothing at all, which reads as a shelf that has stopped working.

**Straight-line distance, not a walk.** `findPath` is the hot loop in the game
and this is asked from `shelvesFor`, which runs per pile per worker per tick —
and a route that changes as you build would move a larder's range while a hire
was walking to it. The honest cost is a stockroom on the far side of a wall two
tiles from the fryer, which is a room you laid out that way.

**Every recipe an owned machine knows, not the one it is set to.** A machine is
one press from another of its own recipes, and a larder that emptied itself
every time you changed the menu would cost you the stock and the board both.
`feasibleRecipe` stays the narrow question — the chef fetches for the batch that
is going to run.

**A shop with no appliances is the old game exactly.** An empty larder reads as
"no rule yet" rather than "nothing, then", or marking a back room before buying
the machine would give you a unit nothing will ever stock — worse than the bug,
and the order everybody does it in.

**`already` is counted per side now**, which is the same split `homeShelves`
makes. Shop-wide, the back room could only ever take an ingredient nobody sells
out front — and tomatoes on the shop floor is exactly what a salsa maker's larder
wants more of, so the rule would have found nothing left to choose and the
stockroom would have stayed bare. The same bug wearing the opposite face.

**Your own hands never read it.** `boardFor`, `stockShelf` and `shelfAccepts` are
untouched, the same line `orders.assign` and `giveUpBoard` draw: you may stand
anything you like in your own stockroom, and a reservation still binds the shop
to whatever you ticked.

What it does not do is *clear out* what a stockroom already holds. Those boards
stop being topped up immediately, and `staleBoards` hands them back four quiet
days later if anybody has the `merchandise` job — otherwise they are yours to
empty, which is one press of Empty on the unit.

---

## Step 8 — seven tabs were two questions ✅

### What was wrong

The strip had grown to seven: Not stocking, Short, On the way, Wanted, Stocked,
Rest, Made here. Every one of them arrived for a reason and each is argued for
above — and read together they are two different questions drawn identically.

The first four are **work**: ten rows between them on a bad morning, each one
something to press. The last three are **the catalogue**: sixty-odd rows split by
a fact already printed on every one of them, since `held` is a column and
made-here is a glyph. So four of the seven were the queue [step 6](#step-6--one-place-per-thing-)
describes and three were an index of the same list, in a strip that is icons only
— and the two biggest badges on it counted things nobody is being asked to do. A
badge means *work* everywhere else in this game, so `25` beside `2` was claiming
to be ten times the job.

### What it does now

Three, and each is a different verb.

| | |
|---|---|
| **To do** | The four job buckets in one list, in their old priority order. |
| **Buy** | Everything you can order. The department strip is the browse axis. |
| **Made here** | Unchanged, and still its own tab: you cannot order it. |

Four notes.

**Nothing is lost by merging the job tabs, because the row already says why it is
there.** A ✕ mark for a line the crew gave up on, "below your minimum of 6",
"in demand right now" — the only thing the old headings added was which pile a
row was in, and a heading over one row is a heading that fits on the row. What
the positions *did* say is the ranking, and that could not survive a merge as a
position, so it is `row.todo` and it leads the sort.

**The On-the-way tab is gone rather than folded.** It read 0 most days, it is the
one bucket you cannot act on, and what is coming sorts to the top of Buy for free
— `dueIn` leads the fallback sort keys and nothing in that tab is a job, so it is
the first key that separates anything. The header still says how many are out and
when the next one lands; the row still says `+6` and the hour.

**Only the first tab wears a badge** (`quiet`, in `grouped`). It is a flag beside
the count rather than a missing count, because two other things read that number
and both still want it: `tabIndex` will not open a menu onto an empty tab, and an
empty tab draws itself dimmed.

**A panel with no work opens on Buy**, which falls out of the two rules already
there — `grouped` files a row in the first bucket that takes it, and `tabIndex`
skips an empty tab when nothing is remembered.

---

## Step 9 — the row was carrying a form ✅

### What was wrong

Step 3 put the standing order on the item's own row: a toggle and two steppers,
in the width left over between a name and a buy button, at fifteen pixels a side.
That is a mouse's control, and half of this game is played with a finger. It also
spent the second line of every row in the panel on two numbers that are unset on
thirty-nine items out of forty, and it had no room for a fourth control — which
mattered, because the one the supplier was most obviously missing is **what you
charge**.

A price has been a fact about a BOARD since there were shelves: `stack.price`,
set once from `suggestedPrice` at the moment the board opens. That is right about
a shop with one shelf and quietly wrong about every shop bigger than that. Eggs
on three units is three prices to set, in three menus, and the fourth board to
open says the suggestion back at you however carefully you set the other three —
including a board that merely *sold out* and got refilled, which reads as the
number resetting itself days after you last touched it.

### What it does now

The row goes back to being a row — what it is, how many you hold, one button —
and pressing it opens the item, the way pressing a hire opens the hire
(`client/item-menu.js`, the third menu built on the head/scroller/foot shape).
Everything you might decide lives there at the width of the panel, with 32px
targets:

| | |
|---|---|
| **Price** | What you charge. `–` means the shop is deciding; `Auto` hands it back. |
| **Keep at least** / **Never more than** | Step 3's two numbers, unchanged. |
| **Crew may order it** | Step 3's `auto`, as a switch you can hit with a thumb. |

`price` is the fourth field on `Game.orders.items[itemId]`, and it is there for
the reason `min` and `max` are: **a rule is about the shop.** "I charge $3.20 for
these" is a sentence no board can say. Four things worth keeping:

**One function answers what a board opens at.** `Game.itemPrice` — your price
else the suggestion — and both callers that open a board ask it: `openStack` for
a new one, and `pourInto` refilling one that had emptied. Honoured by the first
alone, a standing price holds only until the shop runs out of eggs.

**Setting one lands on the shop in front of you.** `repriceItem` walks every
board holding that item. A standing price that only touched future boards is a
control you press in a shop with three shelves of eggs where not one number on
the floor moves — and clearing it hands those boards back to the suggestion,
which is what makes the dash mean "whatever the shop thinks" rather than "the
last number I typed, for ever".

**…and only when the price is the field that moved.** A reprice on a patch that
never mentioned one would quietly wipe the per-board prices the shelf menu exists
to set. The shelf still overrides its own board; the rule decides what a board
*opens* at.

**Zero is a price.** `min` and `max` spell "unset" as `<= 0`, so the price cannot
share their loop: giving something away and never having said are different
sentences.

Made-here goods open the menu too, and get the price row alone — nothing orders a
toastie and `pickItem` never chooses one for a bare board, so a minimum, a maximum
and a may-they-order would be three controls that take a press and move no number.
It is the first price control they have ever had that was not per board.

### On measuring it

Balance-neutral by construction rather than by measurement: with no price set,
`itemPrice` **is** `suggestedPrice`, and `verify:price`'s first section asserts
exactly that — the item's value, the board that opens at it, and an empty rule
map. A price somebody actually sets should be expected to move every number in
the game, which is the point of it.

---

## Step 10 — six was a press, not a quantity ✅

### What was wrong

You could order six of a thing, once, and then not again until the van had been.

Two controls said it, and each was right about its own half. The supplier's row
has one button slot, and Cancel took it the moment anything was on its way — the
argument being that ordering and un-ordering are one decision seen from either
side. The item menu's foot did the same. Both are true of the *decision* and
false about the *press*: `×6` is a press, so the second press is how you say
twelve, and the panel answered it by turning into the undo button.

So the shop would sell you six loaves and then refuse to discuss bread until
tomorrow morning, with the only visible sign being a button that had changed its
word — and there was nowhere in the game to say a number at all. What that reads
as, from a chair, is *"I can only order one bunch of something"*, which is how it
was reported.

Note what it is **not**: `Game.buyStock` has never had an opinion about either.
It takes any quantity and refuses by name against the bay, the floor and the till
(step 1's own note says there is deliberately no fourth ceiling), and it has
never cared how many orders of a thing are already pending. Every part of this
was a client that had decided one order was all anybody meant.

### What it does now

**The row orders. Every time.** One slot still, and it is the buying press —
`Stock` is the one thing that takes it outright, because buying six of something
your crew are carrying back out to the yard is the press that cannot work. The
`+6` beside the count is the receipt, and it climbs.

**Un-ordering moved one press in**, to the item menu's foot, where it sits
*beside* the buy verb rather than in front of it — a five-square strip has room
for both, and ordering more of something already coming is the commonest press
there is: it is how you notice the van is bringing six and the shelf wants
twenty. What is already loaded is still not offered, because `cancelOrder`
refuses it and a control the shop will refuse is the green-ghost bug wearing a
price.

**And the amount is a stepper**, in the menu where every other number about an
item already lives, next to price and the two standing-order figures. It moves
in sixes so the two controls agree about what a case is — `×6` on the row and
`×6` here are one press, and this one says how many cases. Its caption is the
**cost**, not the count: `×30` means nothing beside a till holding $48 until it
says $43.20.

Three things about the amount are worth knowing before touching it:

- **It lives on the menu, not on the shop.** No `item-rule` field, no save. It
  is a fact about the panel you have open, the way `_fxTab` is — the standing
  order is what "how much of this do I want, always" already means, and a second
  persistent number beside `min` would be two answers to one question.
- **It survives the redraw.** `tickItem` re-opens this menu on every van, price
  and board that moves, so the reset is on the way *in* to a different item. Reset
  unconditionally, the number goes back to six under your finger a second after
  you set it to thirty — and the tick that does it is the one your own order
  fired.
- **The press redraws from the handler.** Nothing is sent, so no snapshot is
  coming to say it changed; `itemSignature` deliberately does not mention it.

### On measuring it

Nothing to measure. `simulate` never opens a panel — the balance bot orders
through `buyStock` directly and always could — so this is a client change with no
sim half at all, which is also why there is no sweep: every claim in it is about
which button is drawn.

---

## Gotchas this cost

- **A supply check and a scheduling check look identical.** The pallet guard at
  the top of `restock` reads like "don't buy what you have" and means "there is
  something better to do this tick". One of those bounds the order quantity and
  the other does not.
- **Wages come out of the same till.** The first pass of the functional check
  measured cash delta and reported that a shop with ordering switched off had
  spent $12 — which was a hire being paid. Anything asserting on what the shop
  *bought* has to measure the buying, not the balance.
- **A hire acts on the tick it arrives.** Setting a cap after `hire()` leaves one
  uncapped order already in the day's total, which then reads as the counter
  disagreeing with the till. Set the shop up before anybody is on the floor.
- **`clerk` is authored as serve + tidy.** A test that hires one and waits for it
  to order stock will wait forever and pass with zeros. Assign the jobs the test
  is about rather than inheriting whatever content says today.
- **`.row button` paints every button in a row.** The steppers came out as seven
  fat green buy-pills across each row, because `.row button` is a class plus a
  type and `.rbtn` is a bare class — later in the file loses to more specific,
  every time. Anything adding a second kind of button to an existing row has to
  out-specify the first kind.
- **Tabs that describe a thing are not tabs that help you find it.** Frozen /
  Fresh / Keeps answered a real question — do I have anywhere to put this — and
  organised the whole catalogue around it, which left three flat alphabets to
  scroll and a sub-line that said the same word on every row in a department.
  Short / Wanted / Stocked / Rest is the same list as a queue of work, and the
  storage question moved onto the row as a warning about *that* item. The tell
  was that the panel could not answer "should I buy eggs" — it never showed how
  many eggs you had.
- **Three settings as three rows is a third of the panel.** The first pass gave
  each one a name, a sentence and an On/Off tail, which is the right shape for a
  *choice* and the wrong one for a *state* — a lit icon says "on" faster than a
  word does, and the sentence is a tooltip's job. `.fx-verbs` already existed for
  exactly this and `actIcon` already built the squares; what was missing was a
  section row that could hold more than one press, which is `strip` + `acts` in
  `rowHtml`/`wireRows`. Reach for the shape the panel already teaches before
  inventing a second kind of control.
