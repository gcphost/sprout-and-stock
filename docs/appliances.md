# Appliances — the machine line

Status: **all proposed.** Nothing here is built.

This is a doc about *art*, which is unusual for `docs/`, and it is here rather
than in a comment for the reason docs/fixtures.md is generated: every appliance
in the game is a variant of one `station` row, so what a machine looks like is
authored content that seventeen rows have to agree about, and there is nowhere
else that agreement can be written down.

It does not change a single number. Everything below is `model`, `work` and
`surface` on rows in the `fixtures` table — no `simulate` run, no balance
implication, nothing the sim reads. What it changes is whether a row of machines
looks like a kitchen.

---

## The hole

Line six appliances up and the row looks wrong, and the reason is not the one it
looks like. It is not that the models are bad — most of them read perfectly well
on their own, which is exactly why this went unnoticed. It is that **there are
three generations of art in one catalog** and they share no horizontal line.

| | count | footprint | shared base | accent | tier stages |
|---|---|---|---|---|---|
| **Counter gen** — coffee, blender, toaster, press, juicer, mill, mixer, churn, butcher, blast-freezer, candy-kettle | 11 | 0.94 | a worktop, copy-pasted | warm brown / orange | 2, or none |
| **Freestanding gen** — oven, grill, fryer, soft-serve, preserving-pot, stock-pot | 6 | **0.52–0.65** | none | red `#e8504f` | none |
| **Transport gen** — belt, loader, sorter, lift | — | 0.92–1.00 | plinth, four corner legs, slate body, cap plate | teal `#3f9fb0` | 3 |

The transport family reads as a system because every piece is literally the same
four parts in the same colours with one thing swapped on top: `#4a525e` rail →
`#414956` legs at ±0.36 → `#4e5865` body → `#b9c3cf` cap → a teal part that
moves. That is the whole trick, and it is worth naming because it is *not* what
this doc proposes copying.

And the counter the counter gen "shares" is not shared. There are **four
distinct copies** of it in the table, drifted apart at the surface boards. It
was pasted, not factored, and a paste is a thing that diverges.

### The number that says it out loud

Two shipped fixtures already put a working surface at exactly **0.745** — the
deli counter and the hot counter, independently, which makes 0.745 the shop's
counter line whether anybody decided it or not. Every appliance in the game
puts its worktop at **0.31**.

Stack that against what the machines stand next to:

```
cold-rack      2.02        shelf          1.60
shelf          1.60        freezer        1.57
freezer        1.57        hot-counter    1.47
hot-counter    1.47        gondola        1.34
gondola        1.34        deli-counter   1.16
deli-counter   1.16        checkout       1.07
────────────────────────────────────────────────
tallest appliance in the game: 1.13   (coffee machine, Commercial)
```

**Every shelf in the shop is taller than every appliance.** The kitchen is not a
bit small; it is categorically shorter than everything around it, on a worktop
less than half the height of the counter twelve tiles away. That is why it reads
as toys, and it is why scaling the six small ones up would not have fixed it.

---

## The rule: shared lines, not a shared chassis

The obvious fix is one chassis for all seventeen. It is the wrong fix. A real
commercial cook line is not one cabinet repeated — it is a griddle, a six-burner,
a fryer bank and a salamander, all wildly different silhouettes, all bolted
together into a run that reads as one machine. What makes it read that way is
that everything is spec'd to the same width and depth, so **three horizontal
lines run unbroken the whole length**: kick plate, counter line, cap line.

Your eye reads the lines. It does not read the silhouettes. So:

**Locked, never varies:**

| | value | why |
|---|---|---|
| width (x) | `0.94` | what the counter gen already is |
| depth (z) | `0.94` | ditto — and it is the *face* mismatch that hurts, so depth matters as much as width |
| kick plate | `0..0.09`, inset `0.04`, one dark colour | the bottom line, and the single most "commercial kitchen" detail there is |
| counter line | **`0.745`** | the shop's own, off the deli and hot counters |
| cap line (full only) | `~1.55` | in family with the freezer at 1.57 and the shelf at 1.60 |
| face | flush at `x = +0.47` | a recessed front beside a flush front **is** the gap you can see |

**Free:** everything above the counter line. That is where the whole
differentiation budget goes.

### Three height classes

One class down a row is a wall. Three is rhythm.

| class | top | what it is | count |
|---|---|---|---|
| **Bench** | `0.80` | flat top, the top *is* the working surface | 3 |
| **Bench + head** | `0.90–1.15` | counter line, machine standing on it | 5 |
| **Full** | `~1.55` | floor-to-cap cabinet, face is one flat slab | 9 |

A full-height cabinet at 1.55 is not "big". It is a freezer. It cannot look out
of place next to one, and it is the class that makes the kitchen stop being
short.

### The accent means something

Right now red `#e8504f` is on nine machines and means "a knob". Spend it
instead — the status strip at the counter line says what the machine *does*:

- **teal `#3f9fb0`** — neutral. Ties the kitchen to the loaders and the sorters.
- **red-orange** — heat. Oven, grill, fryer, candy kettle, stock-pot, preserving-pot.
- **ice-blue** — cold. Blast freezer, soft-serve.

You can then read what a machine is from across the shop, for free, and it costs
one part per row. Its `work` model should push the same colour: steam drift for
heat, a cold glow for cold, a teal light otherwise, so a row of running machines
pulses in one rhythm rather than seventeen.

---

## Where the goods go

This is already solved and nobody needs to invent anything: **a part flagged
`surface` is a well.** Same flag a shelf uses for a board — `stationWells`
collects them and `buildStationBays` lays the bays out. Two wells means the art
has said where its hopper is and where its tray is. None means the readout gets
stood on the machine's **roof**, which at 1.55 is the whole problem.

So a full-height cabinet is not "a cabinet". It is a cabinet that has to say
where things go in and where they come out, and the constraint is sharper than
it first looks.

### The constraint nobody would guess

`buildStationBays` sorts a head's wells along **x** and calls the front-most one
the tray; everything behind it is hopper. Wells then band along **z** for a twin
machine's two heads.

Which means: **input is always behind output.** Two ledges side by side on one
flat face cannot express a hopper and a tray — they would be at the same x, and
whichever sorted last would become the tray. So a full-height machine has three
honest grammars and no others:

**Top-load.** Hopper is a funnel on the roof, set back along x; tray is a ledge
projecting from the face at the counter line. Goods go in over the top and come
out at waist height. This is what a mill, a mixer and a churn actually look like,
and it is the one where the tall silhouette earns itself — a hopper at 1.6 reads
as *loading a mill*, where a flat roof with stock floating on it reads as a bug.
→ mill, blender, mixer, churn, candy kettle.

**Two-tier front.** In-feed ledge upper and set back, out-feed ledge lower and
proud. Reads as a pass-through oven or a conveyor toaster: goods enter high at
the back of the ledge stack and leave low at the front.
→ oven, deep-fryer, blast-freezer.

**Pass-through.** In-feed well on the **back** face, out-feed on the front. Load
it from the stockroom, collect it from the shop floor. This is a real thing — a
pass-through dishwasher, a hatch oven — and it is the one that is genuinely
interesting here, because the shop already has a back of house and a `ferry` job
that fills it. A machine you feed from behind is a machine that wants a
stockroom, which is a design idea and not just a picture.
→ butcher, soft-serve, and anything sited on a boundary.

Bench and bench+head classes need none of this: their two wells are the back and
front of the worktop, which is what the counter gen already does and the one
thing about the current art that is right.

---

## The seventeen

Most of these have a real floor-standing equivalent, and it is chest-high. That
is the answer to "what does an industrial blender look like" — it is a 60-litre
vertical cutter mixer, roughly the size of a washing machine, with a cylindrical
bowl and a clamp lid. It is not a jug on a bench.

| | class | what it actually is | wells |
|---|---|---|---|
| oven | **full** | double-stack convection — two doors filling the face | two-tier front |
| blender | **full** | vertical cutter mixer, bowl + clamp lid | top-load |
| mixer | **full** | planetary — column, yoke, bowl | top-load |
| mill | **full** | roller mill, hopper high, chute low — the tallest thing in the kitchen | top-load |
| churn | **full** | horizontal drum on a frame | top-load |
| butcher | **full** | band saw, tall blade column | pass-through |
| soft-serve | **full** | floor unit, taps at the counter line | pass-through |
| blast-freezer | **full** | it is a cabinet | two-tier front |
| deep-fryer | **full** | twin-well floor fryer, baskets above the line | two-tier front |
| coffee-machine | bench + head | commercial espresso group | worktop |
| juicer | bench + head | citrus press | worktop |
| candy-kettle | bench + head | copper kettle on a stand | top-load |
| stock-pot | bench + head | stockpot range | worktop |
| preserving-pot | bench + head | steam-jacketed tilting kettle | worktop |
| grill | **bench** | chargrill — the top *is* the cooking surface | worktop |
| toaster | **bench** | conveyor toaster, wide and low with a chute | worktop |
| sandwich-press | **bench** | countertop press | worktop |

Nine / five / three. A row drawn from that has rhythm in it.

---

## Two things that are just bugs

Both were found measuring for this and neither is about style.

**`sandwich-press` and `juicer` have no stages at all.** Flat `parts` models. Buy
Commercial on either and the picture is byte-identical to Domestic. That is the
"tier that takes money and changes no number" trap wearing art — the number does
move, and nothing anywhere shows it.

**`Twin` has no art on any machine.** The ladder is Domestic → Commercial → Twin,
three rungs. Every variant that has stages has **two**. So rung 2 and rung 3 draw
the same machine, on all seventeen. docs/kitchen.md already names this as the
thing that makes the rung feel dead — *"a twin machine that looks like a single
machine is a slot you have to open a menu to discover"* — and it is worse than
that file recorded, because the count has gone from eleven to seventeen since.

Eight of seventeen have no tier art whatsoever; the other nine stop one rung
short.

Also: **"Domestic" is the wrong word.** The shop is staffed entirely by robots
and the fiction is a near-future automated kitchen; the bottom rung is not a home
appliance, it is the small one. **Bench → Commercial → Twin-head** says the same
ladder without the word that fights the setting.

---

## Traps

**`MAX_PARTS` is 36 per stage, up to 6 stages.** That is generous — the coffee
machine spends 9. A kick plate, a cap, a status strip, two ledges and a head is
still under a third of the budget, so nothing here is tight. What *is* tight is
that the whole model has to be re-authored per stage: three rungs of a
full-height cabinet is the same chassis typed out three times, and the four
drifted copies of the current counter are what happens when that goes unwatched.
If anything here gets built, the chassis wants to be generated rather than
pasted.

**A covered well draws fine and documents as broken.** `stationWells` calls
`surfacesAt` and does **not** filter through `drawableBoards` — that filter is a
shelf's, applied at `scene.js` where boards are drawn. So a hopper tucked under a
projecting lid still gets its bays and still works. What it does do is trip
`npm run docs:fixtures`, which judges every `surface` by `drawableBoards` and
prints a covered one in the ⚠️ lid list — so the authoring reference calls a
working machine broken. Leave real headroom over a well anyway: 0.2 or so, or an
idle machine's ghosted ingredients are drawn inside the thing above them.

**A twin machine's wells band by z.** Nothing has been drawn with two pairs yet,
so `buildStationBays` falls back to standing both heads' bays in the same place
and spreading them. Any full-height art authored for Twin should author two well
pairs offset along z, or the fallback is what you get.

**The counter line is not negotiable per machine.** It is the one number every
class shares, and it is the reason a full-height cabinet with no counter still
belongs in the row — its out-feed ledge sits *on* the line. A machine that puts
its ledge somewhere else is a machine that has left the run.

**Nothing here is measurable.** `simulate` never runs an appliance, so a kitchen
change reports as no change over ten seeds. This is entirely a judge-it-in-play
change, and the instrument for it is `screenshot` with six machines in a row —
which is the *only* thing that shows the failure this doc is about, since every
one of these models looks fine on its own.

---

## What is deliberately absent

- **Not one chassis.** Appliances do not get the transport family's four corner
  legs. Gantry-on-legs means goods pass through; a solid cabinet with a kick
  plate means goods go in and come out changed. That distinction is readable
  across the room and never has to be explained, and it is worth more than the
  extra uniformity would buy.
- **No new `BUILD_KINDS` entry.** Height class is a fact about the art, not about
  behaviour. A full-height appliance blocks its tile and is worked from its face
  exactly as a bench one is. The moment a class needs a different anchor or a
  different reach it has stopped being art and belongs in `shared/build.js`.
- **No per-variant tier ladder.** Shared, as today. docs/kitchen.md step 4 is
  where that argument lives if it ever needs having.
- **No change to `size`.** Every appliance stays one tile. Filling the tile is
  the point; taking two is a different feature and it is docs/pens.md's.

---

## Proposed

**Step 1 — three chassis, three machines.** Author the oven (full), the coffee
machine (bench + head) and the grill (bench) to the spec above, stand them in a
row and look at it. Three machines is enough to prove the lines and cheap enough
to throw away. Everything else waits on that screenshot.

**Step 2 — the six freestanding ones.** They are the loudest offenders (0.52–0.65
against 0.94) and five of the six are full-class, so they are also where the
height classes pay off most. Rebuilding an oven as a module means it stops
looking like a domestic oven, which is the intent and should still be checked by
eye before doing the other five.

**Step 3 — the counter gen, and the base stops being pasted.** Eleven rows, one
chassis, generated. This is the step that retires the four drifted copies.

**Step 4 — the third stage.** Every variant gets Twin art, and `sandwich-press`
and `juicer` get stages at all. This is the one step that is a *bug fix* rather
than a restyle, and it could reasonably go first — it is the only thing in this
doc a player can currently pay money for and not see.

**Step 5 — signal colour on the status strip.** Cheap, and it is the one that
makes the kitchen legible rather than merely tidy. Wants steps 1–3 done first,
because there is no strip to colour until there is a chassis.
