# Demand — what the town actually wants

Status: **audit.** No mechanic here is new. This is a record of what the demand
model reads, and of six things found wrong when the catalogue grew from 78 items
to 103 ([docs/production.md](docs/production.md)). Four are fixed; two are
open.

---

## How the town decides

There is no zoning model and no RCI meter. Demand is **one function over tags**,
and everything else is a multiplier on it:

```
desireFor(item, archetype.affinities)      shared/tags.js:230
  → sum the affinity of EVERY tag the item carries
  → ×(1 + 0.12 × extra matches), capped at 3 matches
  → clamped at 0

purchaseChance(...)                        server/sim/economy.js:219
  → desire <= 0 ? 0 : (desire × demandBoost × seasonBoost × rep
                       + bargain − pricePenalty) / 2.2
```

Three things follow from that, and each is a trap somebody has already fallen
into:

- **A tag with no affinity anywhere is worth nothing.** An item can carry it,
  `docs/fixtures.md` can print it, `list_tags` can bless it, and it contributes
  exactly zero to whether anybody buys the thing. Nothing reports this.
- **An affinity naming a tag that does not exist is worth nothing either**, in
  the same silent way and from the other end.
- **`desireFor` does not know what KIND of tag it is looking at.** Category,
  quality, diet, occasion, trend, property and season all go into the same sum.
  A shopper can therefore be authored to want `shelf-stable`, and one is.

The `/ 2.2` is deliberate and is documented in `economy.js`: a fair price and a
decent affinity comes out around a quarter, because most of what somebody walks
past should stay on the shelf.

---

## What the audit found

### 1. `sweet` is not a tag — fixed

`chancer` was authored `{cheap: 1.4, snack: 1.6, sweet: 1.2, produce: 0.6}`.
There is no `sweet` in `TAG_GROUPS`. That archetype has been missing a fifth of
its pull since the day it was written, and the shape of the bug is the worst
kind: the row validates, the shopper works, and they are simply less interested
in confectionery than the person who wrote them intended. Changed to `candy`.

### 2. Five tags nobody had an opinion about — fixed

`party`, `lunch`, `viral`, `nostalgic` and `vegetarian` appeared on items and in
**no archetype's affinities**. So every item carrying them was advertising a
quality no shopper in the game valued: the whole `viral` trend existed for
`rainbow-bagel` and pulled nothing, `nostalgic` existed for `liquorice` and
pulled nothing, and `lunch` was on five prepared foods and pulled nothing.

This is the `charm` trap exactly — *a working system with no content in it is
indistinguishable from a broken one* — arriving from the demand side rather than
the supply side. Affinities added across seven archetypes.

**It is a balance change**, and it is the one thing in this audit that moves
money. See the measurement below.

### 3. `bulk-shopper` wants two PROPERTY tags — fixed at the item end

`shelf-stable: 0.9` and `bulky: 0.8`. That is a legitimate way to author "big,
cheap, keeps for ever", and it was harmless while every item also carried a
category. [docs/production.md](docs/production.md) then authored items that
carry *nothing but* property tags on the explicit theory that they would score
zero — and `groundnuts` and `mustard-seed` came out at **1.9**, better than most
of the shop.

Fixed by tagging those three honestly as the retail products they are. **The
underlying hole is still open**: there is no way to author "this is not a retail
product", because `desireFor` sums every tag and the schema's tag list is
`.min(1)`. Items tagged only `perishable` keep a ~4% residual browse chance.

### 4. `generic` is an affinity no item carries — open, harmless

`foodie` has `generic: -0.7` and not one of 103 items is tagged `generic`. It is
a penalty that can never fire. Left alone deliberately: the fix is either to
delete a considered piece of authoring or to start tagging own-brand goods, and
the second is a content decision nobody has made.

### 5. **`staples` is dead content on every archetype** — open

Every one of the nine archetypes has `staples: []`.

The column is documented in `shared/schemas.js` as *"tags this shopper actually
came in for — miss one of these and they leave annoyed and it is counted against
you"*, and there is real machinery behind it: `STAPLE_RESOLVE`, a separate and
much sharper roll than the browse, and `Game.failLine`'s *"came in for dairy and
you had none"*. `economy.js` carries a long comment about a Budget Parent whose
staple is `dairy`.

Nobody has ever set one. So the sharp roll never happens, every shopper in the
game is "just browsing", and the difference between a shop that stocks a
department and one that does not is a browse chance rather than a walk-out.

This is worth more than everything else in this file put together and it is
**not** fixed here, because switching it on is a large balance change: it makes
every gap in the shop cost reputation at the staple rate rather than the browse
rate. It wants its own measured pass. The one-line version of the finding:
**the most interesting mechanic in the demand model has never been turned on.**

### 6. Six departments the van can no longer stock — open

Downstream of [docs/production.md](docs/production.md), and the numbers are
there. `bakery`, `frozen`, `snack`, `prepared`, `candy` and `condiment` have
**zero** orderable items — every one of them is now craftable, and `buyStock`
refuses anything craftable.

That interacts badly with finding 2, and the interaction is the whole reason
these two are written down together: adding `viral` demand created 207 unmet
asks in a 60-day run for an item (`rainbow-bagel`) that the shop **cannot buy at
any price**. Demand you cannot serve is reputation damage, not an opportunity.

---

## What it measured

Three seeds, 60 days, against a **frozen copy** of `shop-3` under `SNS_DB`, with
the archetype affinities as the only difference — the method CLAUDE.md
prescribes, because two runs against the live world are two different shops.

The comparison is in the table at the end of this section once both arms
completed. Read it with the caveat that stands over every kitchen change in this
repo: **`simulate` never works an appliance**, so a run measures a shop selling
raws only. With six departments craft-only, that is a shop with six empty
aisles — which is why the absolute numbers are grim in both arms and only the
*difference* between them says anything about the affinity edit.

---

## The rule this file exists to state

**Whenever a mechanic reads a content column, check how many rows have ever set
it.** CLAUDE.md says it about `charm`, which was authored on exactly one row out
of nineteen. It is true here three times over: `staples` on zero rows of nine,
`generic` on zero items of 103, and five tags on zero archetypes of nine.

Each one is a system that is running perfectly and doing nothing, and not one of
them logs a word.
