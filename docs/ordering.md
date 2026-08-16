# Ordering — what the shop buys, and who decided

Status: **steps 1–2 built.** The restocker counts what the shop can already
supply itself before it spends money, and the three decisions it used to make
silently are switches in the supplier. Step 3 — refill lines on the shelf
itself — is proposed.

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
