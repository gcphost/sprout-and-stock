# Handoff — the `pen` build kind

Paste this to a fresh agent. Everything below was established in the session
that authored [docs/production.md](docs/production.md); read that file and
[CLAUDE.md](../CLAUDE.md) before touching anything.

---

## The task

**Animals are currently crops, and they should be buildings.**

`docs/production.md` added five animal "crops" — `dairy-shed`, `pig-pen`,
`cattle-pen`, `poultry-run`, `turkey-pen` — plus `beehive`, on the precedent
that `chicken-coop` has always been one. It works, and it is wrong in play: you
place a *raised bed*, open its seed picker, and sow a cow. Then you re-sow the
cow every time you collect. Nobody re-sows a cow.

Build a **`pen` build kind**: a fixture you place from the **Farm** tab that
holds an animal, fills up on its own clock, and is collected without ever being
re-sown. One pen per animal, each with its own art.

The seven: **Dairy Shed** (milk), **Chicken Coop** (egg), **Pig Pen** (pork),
**Cattle Pen** (beef), **Poultry Run** (poultry), **Turkey Pen** (turkey),
**Beehive** (honey).

The user's words: *"i'd like a pen for each, in the farm, with unique designs
that look good."* The art is a first-class part of this, not a finishing touch.

---

## What shape it should be

A `pen` is a **fixture** (`FIXTURES` in [shared/build.js](../shared/build.js)),
not a crop and not ground. Sketch, to be argued rather than obeyed:

```
pen: { label: 'Pen', blocks: true, where: 'outdoor', rotates: true, anchor: 'useAt' }
```

- **Kinds are code, pieces are content.** One `pen` kind; seven `fixtures` rows,
  each with its own model, its own price and the item it yields. Do **not** add
  seven kinds.
- It yields on a timer and **refills itself**. No sowing, no seed cost. The
  purchase price of the pen is what you pay.
- Collecting is the interesting question: the closest existing verb is the ripe
  bed (`harvest`), which is the one goods action that fires on the tile under
  your feet. A pen has a working spot (`useAt`), so it is more like a station's
  tray — read `collectStation` and the ripe-bed notes in CLAUDE.md and pick one
  deliberately.

### The two clocks problem — read this before modelling

One resolver takes ONE 0..1 number. A pen has **two**: which tier it is, and how
full it is. That is exactly why an appliance has both `model` and `work` — see
CLAUDE.md and [docs/kitchen.md](kitchen.md). Use the same split: `model` staged
by tier, `work` drawn over it and driven by fullness. Do not invent a third
mechanism, and do not spend the tier number on fullness — a pen would then stop
showing you which one you bought.

---

## The traps, every one of which has bitten before

**The four places a new kind dies quietly** (`verify:bin` wrote these down, and
`belt` hit two of them ten minutes after shipping):

1. `compose`'s `else` is `makeShelf` ([server/layout.js](../server/layout.js)) —
   a kind with no branch is not refused, it is **silently built as shelving**.
2. `compose`'s budget map is literal keys against
   `if (!(budget[p.kind] > 0)) shed(p)`, so a kind with no line is built,
   charged for, then dropped **and refunded** by the re-flow the purchase itself
   triggers. Money back, nothing looks stolen, and what you see is the shop
   accepting something and then refusing it.
3. `FIXTURE_KINDS` and `budgetOf` in [shared/build.js](../shared/build.js) must
   stay **derived**, never listed.
4. `fixtureUnitCost` — price off the catalog row, never a fallback.

**`generateLayout` is called from TWO places** and each spells the budget
hand-off out by hand: `Game.create` and `regenerateLayout`. A kind added to only
the first works perfectly until the next re-flow, which is the purchase itself.
This is trap 2 arriving by a different door.

**`verify:catalog` asserts every fixture either occupies its cell or IS what the
cell is made of.** If `pen` is `blocks: true` that is satisfied; if you make it
walk-over, it needs a `ground` stamp or you can stack unlimited pens on one
square. That invariant is deliberate.

**`repositionFixture` NAMES every field it keeps.** A field it forgets is not
un-copied, it is **reset to default** by the re-flow the same call triggers. The
press is **R**. So whatever a pen stores — how full it is, when it last yielded
— must ride through `repositionFixture` explicitly, or turning a pen empties it
and it looks exactly like the button not working.

**Any timer must not be persisted against `elapsed`.** That clock restarts at
zero on every load, so a saved stamp sits in the future and the pen never yields
again. `plantedAt` stores how long it *has* grown; `yieldedAt` is in-memory with
an `elapsed` guard. Copy one of those, do not invent a third.

**`Game.create` does not spread the save, it NAMES every field.** A new save
field needs writing in `saveState` on the way out **and** in that payload on the
way in. Forgetting the second is the quietest bug in the file — the value
persists, reloads as the `??` default, and the next `persist()` writes the
default back over what was stored. `paint` shipped that way for five steps.

**Palette placement** is `KIND_TOOLS` in
[client/sections.js](../client/sections.js): add `pen: { icon, group: 'farm',
blurb }`. A kind missing from that table still builds, it just gets the generic
icon. (Note: Mill, Churn and Butcher's Block were just moved to the Farm tab via
`payload.group` on their upgrade rows — a pen should sit alongside them.)

---

## Migrating the existing animals

Seven crop rows currently produce these items. **Do not simply delete them.**

- A plot somewhere may be sown with `chicken-coop` right now — it is in the
  shipped seed and predates all of this. Work out what a plot with an unknown
  `crop_id` does *before* removing any row; if it is not graceful, that is a bug
  to fix rather than a risk to take.
- The live world is `shop-3` and people play it. Content is edited live.
- `binOrphans` covers unknown *items*, not unknown crops.

The safe order is: build `pen`, author the seven pieces, verify, and only then
retire the animal crop rows — with the `chicken-coop` question answered.

---

## What "looks good" means here

There are no art assets. Every model is a JSON pile of `box` / `sphere` /
`cone` / `cylinder` / `capsule` parts — see `PART` in
[shared/schemas.js](../shared/schemas.js). Constraints: **36 parts per stage**,
2–6 stages, positions in tiles (1.0 = one tile), `#rrggbb` colours only.

- The seven must be **visually distinct at a glance from an isometric camera**.
  A beehive and a chicken coop that both read as "small brown box" is a failure
  even if every number is right.
- Look at the existing animal crop models for the level of detail expected —
  `chicken-coop` has a hen with a comb and a beak in four stages.
  `client/render/palette.js` is where colours live.
- A pen should read as **occupied** at a glance when it is ready to collect.
  That is the `work` model doing its job.
- Nothing rotationally symmetric for a moving part — `verify:motion` records
  that spinning a cylinder is a perfectly correct animation nobody can see.

---

## How to verify

- **`npm run verify`** — 30 sweeps, about a minute. It must be clean. Expect to
  add a `pen` section; `verify:catalog` and `verify:build` are the two that will
  catch a new kind misbehaving.
- **`screenshot`** via MCP, then *look at it*. Six of the seven have never been
  drawn. `stock_shop` first if you want a furnished shop.
- **Export**: `npm run export && git add data/seed` — content authored live
  exists only in the local database until you do.

### ⚠️ Do not run long `simulate` loops

Three 60-day runs in a loop pegged the user's laptop at 100% CPU and had to be
killed. `simulate` is also **blind to this feature** — the balance bot never
works an appliance and will not work a pen either, so a run measures nothing and
costs a lot. If a balance question genuinely needs answering, ask first and run
**one** short run against a frozen `SNS_DB` copy, never against the live world.

---

## House rules that apply

From `.claude/skills/rules`, and the user enforces them:

- **R3** — reuse before writing. If something does 80% of what you need, extend
  it. Hard cap 600 LOC per file, target 300.
- **Verify before writing.** Grep for an identifier before assuming it exists.
  "It would make sense for this to exist" is not verification. This session
  shipped a wrong claim about `desireFor` by assuming exactly that.
- **Reply in ELI5 TLDR bullets.** No walls of text, no end-of-task recaps.
- **Never silently pivot scope** — if this turns out to need a change to a
  shared base type or core dispatch beyond `shared/build.js`, stop and ask.
- **No legacy fallbacks** unless asked. Fix the data or use one strict path.
- **Check `docs/` first, and document what you build** — this wants its own
  section in [docs/workers.md](workers.md) or a doc of its own, in the house
  style: argue *why*, and name the traps you hit.
- "**mate**" means stop and re-read your last message; it is not approval.

---

## State of the tree when this was written

Uncommitted and working: 29 new items, 15 crops, 6 appliances (Mill, Mixer,
Churn, Butcher's Block, Blast Freezer, Candy Kettle), 68 recipes, the variants
cap raised 16 → 24, `payload.group` on upgrades, and fixes to `verify-yard.js`
and `verify-hand.js`. `npm run verify` was clean at that point and content was
exported.

Two things are **open and not yours unless the user says so**:

1. **The van fork** — `buyStock` refuses anything craftable, so 68 of 103 items
   left the supplier and six departments (bakery, frozen, snack, prepared,
   candy, condiment) have zero orderable items. Written up in
   [docs/production.md](production.md).
2. **`staples` is dead content** on all nine archetypes, so the sharpest
   mechanic in the demand model has never been switched on. Written up in
   [docs/demand.md](demand.md).
