# Handling — how goods get into and out of your hands

*Status: steps 1 and 2 built.*

Everything else in this folder is about a system the shop runs. This one is about
the twenty seconds a player spends holding something, which is the part of the
game a seven-year-old meets first and the part that decides whether they meet
any of the rest of it.

---

## 1. The grade, and why it went

For most of this game's life a press on goods came in two sizes.

> **A tap is one unit, a hold is the lot.**

It is a good rule. It is consistent, it reads well written down, and it was
argued for at length — a crate, a board, a hopper and a square all obeyed it, so
learning it once was learning it everywhere. Nothing below is a claim that it was
sloppy.

What it cost is the size of the thing you had to learn. Two buttons × two
durations × five kinds of target is twenty sentences, and `pressHints` had all
twenty of them written out. That is not a rule, it is a *table*, and the tell is
that the game had to grow a strip of UI along the bottom of the screen to read
the table out to you.

Three things settled it.

**Nobody ever took one.** The single-unit press exists for walking round the shop
plucking one of each, and that is not a loop this game has. It was asked
directly, of the person who plays it most: *"no, i never once just ran around and
picked 1"*.

**A hold is undiscoverable.** This is not a matter of taste — long-press is
found by curious and expert users and nobody else, which is why every
interface that leans on one grows a hint next to it. Ours did. And the audience
here is a child: the usability work on 6–8 year olds says limited
motor-coordination demands and simplified gestures, and a timed press that means
something different on each mouse button is precisely the shape that guidance
names.

**The genre already answered.** Supermarket Simulator is the incumbent and its
loudest complaint is the restocking loop; its most-installed mods are *hold the
box, one key, everything goes to its shelf* and *carry three boxes at once*.
Overcooked runs the whole co-op kitchen on one context-sensitive button. The
market wants fewer and bigger goods gestures. Not finer ones.

So the grade is gone, and what is left is the half that was always doing the
work:

> **Left takes. Right puts. One press each. However long you hold it.**

## 2. What that cost, and what paid for it

The grade was load-bearing in one place: **the ring**.

`stepActions` winds a charge only while `p.pressing`, and that rule is about
CONSENT. It was written when proximity armed everything — you walked past a ripe
bed and picked it — so the button was how you said *this one, and yes*. An errand
is not that. You pointed at the thing and pressed it; the sentence is finished.
Asking for the button a second time is asking the same question twice, and it is
the whole reason every goods verb was a timed hold.

So `errandAction` stamps `auto: true` on what an errand names, and nothing else.
A till with somebody at it is still proximity and still wants the press. Walking
away still throws the charge away — that half was doing the work all along, and
it is what `moving()` is for.

**And there are no exceptions.** The skip was argued for and shipped as one —
nothing in the shop undoes throwing goods away, so it kept the ring and the ring
kept its button — and it lasted about ten minutes, because one exception is not a
safeguard, it is an asterisk on the rule every other target in the shop teaches.
A press on a skip is aimed at the skip while you are carrying something, which is
two deliberate acts already. The whole hold apparatus went with it: `pillPress`,
`errandHold`'s 20-second backstop, its snapshot watcher, its window-level let-go
and the pill's own arm timer.

What replaced the `hold` tag is `ringRow`, which is `walkRow`'s sibling and
exists for one reason: the pause. A ring is the world running, so a row that
winds one must not be offered over a stopped shop — that veto used to read the
tag, and no goods row carries a tag any more.

### The inversion nobody would predict

Arming an errand on the way DOWN used to be free. Nothing could fire with the
button up, so a press that turned out to be a camera turn or a pan simply left a
target standing and never spent it — and arming early was what let the ring wind
under the same press.

Under `auto` that reverses exactly. A press that turns out to be a **pan** would
now lift the box you dragged from, and a right-drag to turn the view would empty
your arms onto the shelf you started the drag on. Both are the gesture people
make most.

So the press **decides on the way down and sends on release**. Deciding early is
what keeps the answer about the thing you pressed rather than about wherever the
pointer drifted to; sending late is what keeps a turn from being a put. The
release is already the one place that knows the press stayed put (`TAP_SLOP`).

`armPut` carries this as a `send` field rather than calling `net.send` itself —
one function still owns the decision, and one place performs it.

## 3. What is NOT lost

- `crate-one`, `shelf-one` and `station-one` are untouched verbs on the server.
  Nothing sends them today; the single unit is a thing the shop can still do, and
  a menu row is where it belongs if it is ever wanted again.
- **Merging is a crate verb, not a hand verb.** Set a box down on a box of the
  same thing and `dropGoods` tops it up — assembling a full crate out of part
  ones is the same press as everything else, and the packer is the machine that
  does it for you.
- The pill still names every press. It is a *label* on the gesture now rather
  than a table of them: one row per direction per target.
- Holding on a fixture still opens its menu (`HOLD_OPENS`). That is not a goods
  verb and it never graded — it is the second half of every press in the game.

## 4. The same rule for the crew

> **One trip is one box.**

The player's half of this was step 1. The crew's half is the same sentence and
it is the one somebody actually watches, because a shop of six restockers is
six bodies crossing the floor all day.

They were moving almost nothing. A hire at the bay took an *armful*, and
`fillHands` only ever tops up a kind already in the arms — so three part-crates
of four against six-unit hands is three walks of the shop, one per box, for
ever. Nothing about that looks like a bug: every hire is visibly working, every
trip is a real trip, and the boxes do eventually empty. It is the exact
complaint the genre's players make about restockers, and the mods that answer it
are the two named in §1.

What stood in the way was one comparison. `wholeCrate` shouldered a box only if
it held **more than an armful** — the claim being that at or under an armful the
box is pure ceremony, one journey either way, and you arrive holding a crate
instead of holding the goods. That is true of a single box in isolation and
false of a bay, which is the only place crates come in. Each box is judged on
its own contents, so the bay it is worst on is exactly the bay it was written
for.

### Why it is deleted rather than fixed

The comparison had already been patched twice, and both patches were right:

- **`bar`** swapped `hands` for what the armful would actually move, because a
  rung's `carry_mult` can raise an armful to a whole crate — twelve-unit hands
  against a twelve-unit crate is `12 > 12`, false — so the one hire you would
  promote *to* run the back was the one hire who could never shoulder a box.
- **`beltTakes`** short-circuited the whole test, because a box put on a run
  makes no journey at all past the first cell, so comparing two walks is asking
  a question that has no bearing.

Two patches, one hole: **a comparison between two journeys cannot see the bay
the box is standing in.** A third patch would have been a third instance. So the
size test is gone, and with it `bar`, `packFill` and `beltTakes` — there is no
comparison left for the next `_mult` to invert, and the belt case needs no
special pleading because the general rule already covers it.

Three conditions survive, and each is load-bearing rather than a preference:

- **empty-handed** — `liftCrate`'s own rule, which is why this sits after the
  top-up branch.
- **on a pad** — the termination argument. Haulage runs one way, out of the
  yard, so no pair of shelves can pass a box back and forth for ever.
- **on top** — `liftCrate` refuses a buried crate, and a refusal here is not a
  no-op. Falling through to the armful path is what keeps a bay stacked three
  deep moving at all.

What replaces "room for more than an armful" is the candidate loop that was
always above it: `fit` already skips any crate with no room for even one unit.
The remainder is not a problem worth guarding — `stockFromCrate` pours every
board that will have it and keeps the rest on the shoulder, and the haul branch
walks what nothing wants back to the pad. That was already the answer for a
part-crate hauled under the old rule; it is now the answer for all of them.

**The armful is not gone.** It is the path for a stray in an aisle, for a buried
box, and for a hire whose hands are already full — see the note at the foot of
§5. Nothing was removed; a branch stopped being the common one.

### What `packs` means now

The rung no longer buys the *lift* — everybody lifts. It buys what is in the box
when it leaves: a plain hire walks the four they were standing on, a packer
walks twelve. That is a narrower thing than it was, and `verify:pack`'s control
is sharper for it, because the old control passed for two reasons at once (no
packing **and** no lifting) and could not tell them apart.

### The bug it uncovered

`boardFor` is not a predicate — it calls `openStack`, which pushes a real priced
board as a side effect of being asked. The haul branch was `.filter`ing every
candidate shelf through it, so it opened a board on every unit the hire
*considered* and then stocked the first one. Survivable while hauling was the
exception, because a crate big enough to shoulder usually held something with a
home already, and a home is one candidate. This step makes every bay crate come
through there, and an item with no home yet has the whole shop as candidates:
four boards standing, stock on one, three holding nothing and counting against
`shelfHasRoomFor` for every other kind. Nothing logs it, and what it looks like
is a shop that has quietly run out of shelf space.

`shelfAccepts` to **probe**, `stockFromCrate` to **commit** — which is
`verify:belts`' rule for the loader, said about the hire. It asks the same three
questions and writes nothing.

### What is NOT measured

`simulate` was not run over this, at the player's direction, and the honest
statement is that **the balance delta is unknown rather than neutral**. It is
plausibly positive — the same goods reach the shelves in fewer journeys, and
`bayRoom` frees faster because a lifted box leaves the pad whole rather than
four units at a time — but nothing here measures that, and this paragraph is not
a claim that it is free.

The one direction it could have gone badly *is* measured, because it is a
correctness question rather than a balance one. A hire now commits to a box
before knowing the shop can absorb all of it, so the worry is a full shop
walking a crate out and back for ever. It does not: the box is lifted once, one
unit lands, the remainder goes home to the pad, and `fit` scores the returned
crate at zero from then on. Cost is bounded at one extra round trip per crate in
a shop with no room, and it stops. `verify:pack` §10 pins exactly that — the
single lift counted as pad-to-shoulder transitions over three hundred seconds,
with conservation — because the deleted size test used to be what made the claim,
and a claim that survives its own guard needs a new one.

What is left unmeasured is the takings. If the shop starts reading as *slow*
rather than as busy, that is the thing to put ten seeds behind.

## 5. Steps

1. **Built.** The grade is gone; a named errand fires without the button.
2. **Built.** One trip is one box for the crew as well — the size test on
   `wholeCrate` is deleted rather than patched a third time. Not measured; see
   above.

**The armful stays.** Retiring `p.carry` outright was proposed and dropped: it
is ~330 references across the sim, the client and sixteen `verify:*` sweeps, every
one of them a conservation site, and the player-facing win was already paid for by
step 1 — nothing fills your hands by press any more. Keeping the code costs
nothing and leaves the door open.

## 6. The rule for the next goods verb

**One press, one outcome, per direction, per thing.** If a new verb wants a
second size, it wants a menu row. If it wants a hold, it wants an argument that
beat the skip's — and the skip's was the strongest there is, and lost.
