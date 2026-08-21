# Security — the shopper who does not pay, and what you can do about it

> Status: steps 1–4 built; 5 proposed.

The shop has three ways to lose stock and not one of them is a *person*.
Spoilage is a clock, orphaned goods are a deleted row, and walk-out shrinkage
is a sensor misreading a crowd. All three are taxes: they happen, you read a
number afterwards, and the only lever is a purchase.

A shoplifter is the first loss with somebody attached to it, and that is the
whole reason to build one. **The theft is not the feature. The tell is.** A
thief you never notice is walk-out shrinkage with extra steps — the same units
gone, the same line in the ledger, and nothing to do about it that you could
not have done by buying hardware. What makes it a mechanic rather than a
number is that the shop *shouts*, and then it is up to you.

Which sets the order of everything below: nothing here is worth building
before the moment you find out.

---

## What already exists

- `steal_chance` was specified in [customers.md](customers.md) step 5 and never
  built. Its argument was that abandoned baskets already destroy stock, so
  naming it is nearly free. That argument is *true and too small* — it buys a
  log line, not a chase.
- `KIT_USES` says out loud that `stealing` joins it "the day theft does, and not
  a step before". The swag bag is already an authorable kit tagged `thief`.
- `aimPerson` (client/main.js) already answers "which person did you point at",
  settled on `pointermove` so somebody walking under a still pointer cannot
  steal the aim. A tazer is that question with a range check on it.
- `camPan` is an offset off the player with a 14-tile leash, and `setFreeRoam`
  already swaps that leash for the map in build mode. A cinematic cut is a
  third owner of the same field.
- Staff already have `energy`, `TIRED_PACE` and a pace multiplier. **Player
  stamina is not that** — see step 3.

---

## 1. The thief — a shopper who leaves without paying

`steal_chance` on the archetype, defaulting to 0, so every archetype ever
authored is untouched and the roll never happens in a shop nobody has tagged.

Rolled at the moment they stop shopping, which is the one tick where the
decision is real: they have a basket, they are about to pick a till, and
`goToTill` is the fork. On a hit they take the goods and head for the door.

Three things this rests on.

**It is a flag on `LEAVE`, not a state — and this doc argued the opposite
first.** A `STEAL` state beside `LEAVE` reads better and is wrong here: a dozen
loops ask "is this person on their way out" (`stepMood`, `measureOccupancy`,
the snapshot, `driveOff`, the re-flow's rule about not restarting somebody who
has finished), every one of them is already right about a thief, and a second
state means teaching all of them a second spelling. That is the `inACar` trap,
and it fails in whichever loop somebody forgets rather than where the mistake
is. `storming` is the precedent — a boolean on a leaving shopper that changes
their speed — and `stole` is the same shape.

**No money moves and no reputation moves.** The goods leave, `stats.stolen`
counts them, and the town's regard is untouched, for exactly the reason
spoilage is not in `REP_CAUSES`: nobody who walked in today saw it. Reputation
enters at step 5, where the robbery is public.

**The goods are still theirs to lose.** They come out of `basket` into `bought`
the way a paid trip does, so a thief who is caught can be made to hand them
back — which is step 3, and is the reason the stock is not simply deleted here.

## 2. The tell — the shop shouts and the camera cuts

The bit that makes it a game. The moment a thief commits, the camera leaves you
and frames them for a couple of seconds over an alert, then hands itself back.

**The camera is on loan, and the loan is interruptible.** CLAUDE.md's rule for
`camPan` is that a view which can lose you is worse than one that cannot see the
far shelf. A cut that holds the camera while somebody is running is exactly that
failure, so: it is time-boxed, *any* input takes it back early, and `recentre`
is what it hands back to. A cut you cannot cancel is a cut that eats the chase
it is announcing.

**The alert is a sound and a marker, not a UI panel.** A panel is somewhere to
look while the thief runs. The marker rides the thief (`aimPerson`'s highlight
in another colour) and survives the camera coming home, or the cut has told you
something you immediately lose.

**It fires on the COMMIT, not on the spawn.** A shop that flags the thief as
they walk in is a shop that has read their mind, and the interesting decision —
do I follow this one — evaporates.

## 3. The chase — sprint, stamina, and the tazer

**They are faster than your walk and slower than your sprint.** That single
inequality is the whole mechanic. Equal to your walk and there is no chase;
faster than your sprint and there is no point starting one.

**Stamina needs hysteresis, and nothing about that is obvious.** An emptied bar
regenerates a sliver, that sliver buys exactly one sprinting tick, and the
player strobes between running and walking several times a second. It is
invisible in the readout — the bar is on the floor either way — and reads as
the sprint key being broken. `STAMINA_FLOOR` is the fix: once flat, you are
winded until a real chunk is back. `verify:theft` found it, which was the only
way it was ever going to be found.

**Stamina is a budget, and it is not `energy`.** A hire's energy is a shift-long
resource that a break refills and that pins them at `TIRED_PACE` when it runs
out. Yours is seconds long, refills on its own, and running out just means you
walk. Sharing the field would put a shopkeeper who chased somebody at lunchtime
on a robot's break schedule.

**The tazer is aim, not reach.** `aimPerson` already resolves who you pointed
at, so the verb is a press against a marked thief inside a radius — no walking
up, no hold, because a 0.5s charge in the middle of a sprint is a gesture that
loses every chase it is used in. It is the one action in the game with a
cooldown rather than a duration.

**Catching them returns the goods to the floor**, as an ordinary pallet through
`dropGoods` like every other setdown. Never straight back onto the shelf: the
crate is the receipt, and a stocker tidying it away is a job that already
exists.

## 4. Security workers — the job that does it for you

A `guard` entry in the job vocabulary, drawn like any other directive, so it
costs points against `JOB_POINTS` and competes with shelving.

**A guard is a deterrent first and a chaser second**, and that ordering matters:
a shop that has to catch every thief is a shop where the mechanic is a tax on
your attention. Presence on the floor scales `steal_chance` down; the chase is
what happens when the deterrent failed.

**It must not become a shop that plays itself**, and the thing that stops it is
arithmetic rather than a rule: a hire walks at about 2.6 and a thief runs at
4.62, so a guard who spots somebody already running essentially cannot close.
What they can do is be *in the way* — which turns "where do I post my guard"
into the whole decision, and the shop answers it honestly. By the door they
intercept; at the back they are decoration. No special case was needed to make
a guard lose a foot race, which is the version of this worth keeping.

## 5. Robbers — the one that is public

A thief goes for a shelf; a robber goes for the **till**, which is the pile of
cash on the counter, and does it in front of everybody.

This is where reputation finally moves, and it moves for a reason that survives
the argument used to keep it out of step 1: a robbery is *witnessed*. Everyone
in the shop saw it, some of them leave, and the town hears about it.

Deliberately last. It needs the chase to exist to be anything other than a
random fine, and it needs the guard to exist to be anything other than
unfair.

---

## Steps

1. `steal_chance` on the archetype, the `STEAL` state, the flee route, the
   `stats.stolen` tally and the day line.
2. The tell: the camera cut, the alert, the marker that outlives it.
3. Sprint + stamina (Shift — it shares the key with the kin preview, which
   no-ops unless a fixture is selected), the tazer verb and its cooldown,
   catching and the dropped crate.
4. The `guard` job — deterrence off the roster (`guardDeterrence`, saturating
   so a wall of guards cannot retire the mechanic), the doorway post, and the
   catch, which is `catchThief` shared with your own tazer.
5. Robbers: the till as a target, witnesses, and the reputation hit.

**1 and 2 are one change in practice.** A thief nobody is told about is
shrinkage that took a longer code path to arrive at the same number, and
shipping 1 alone would put a mechanic in the game whose entire content is a
line in tomorrow's log. 3 is the first one that is separable, and it is also
the first one that is *fun*.
