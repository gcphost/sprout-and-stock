# The roof — a ceiling you can only see from under it

Status: **steps 1–2 built.** 3–4 proposed, and the light half of step 2 is open —
see **The one thing step 2 did not do**.

---

## The hole

First person puts the camera at `FPV_Y` — 1.11 tiles, just under the crown of a
head — inside a building whose walls stop at 2.1 and whose ceiling does not
exist. Stand in the aisle, look up, and you are looking at the sky. Every
interior in the game is an open box seen from inside, and the one view that
cannot use the overhead convention is the one view that shows you it.

It is worth being precise about what is missing, because it is less than it
sounds. **The roof already exists twice. What it has never had is a mesh.**

- **In the light.** `Lights.openness(x, z)` (client/render/lights.js) answers 0
  indoors and 1 outdoors, and `ROOF_LEVEL` (0.72) is what a cell under it is
  worth at noon. Every indoor surface in the shop is already dimmed by a roof
  nobody has ever drawn — the file's own section is called THE ROOF.
- **In the walls.** `WAYS` (shared/edges.js) carries `roofs` per kind: a curtain
  roofs, a gate does not, an arch does. Which openings make a room is authored
  data and has been since the second kind of opening existed.

And the constant is already called `CEILING_Y`. Its comment in palette.js says
a pendant an inch too high "pokes through the roof of a building that has no
roof". The vocabulary is all here.

---

## What other games do, and the one rule under all of it

| Game | What it draws |
|---|---|
| **The Sims** | Real roof geometry, auto-removed at the wall-cut zoom (walls-up / walls-down / cutaway). Sims 4's first person draws ceilings. |
| **Project Zomboid** | Cuts the roof of the storey the camera is on, keeps every other building's. |
| **Prison Architect / Two Point** | Roofs exist for the exterior view and are removed per-room once you are looking inside. |
| **RimWorld** | Never models one at all. The roof is a data layer drawn as a shadow overlay — you see *that* a cell is roofed, never the roof. |

The rule all four share: **the roof is hidden for the room the camera is in, and
drawn everywhere else.**

Sprocket & Stock cannot say "the room the camera is in". Enclosure is shop-wide
and all-or-nothing (this file's own trap, below) — there are no rooms to be in
one of. What survives of the rule is the camera **mode**, and it answers the
same question honestly: in the overhead view the camera is never in a room, and
in first person it always is. `this.fpv` is the entire switch.

Which is the same sentence `ghostNearWalls` already says about walls, one
surface along:

> And FIRST PERSON keeps everything. The cutaway is a convention of the overhead
> view — down at eye level the wall in front of you is the room.

---

## Step 1 — the ceiling is the indoor mask

Built. `Scene.addCeiling`, `ROOF_Y`, `PALETTE.ceiling`.

`L.indoor` is on the layout, sent to the client already
(`server/layout.js:1265`), and is read in `buildWorld` today. A ceiling is that
mask extruded at a height, in a group of its own under `staticRoot`, visible
while `this.fpv`.

That is the whole feature. There is no new content table, no new build kind, no
new tile, nothing on the save and nothing the sim ever reads.

### It is per CELL, never a lid on the building

This is the half that answers "but sometimes I want to see outside", and it
answers it without a toggle.

A lid shaped like the building is a thing you are either under or not, and
walking out of the front door would be a hard cut between two states. A ceiling
that is *the mask* has the doorway in it: step through and the ceiling stops at
the wall line behind you and there is sky ahead, because that is what the mask
says. Stand in the yard and there is no roof anywhere near you. Knock the back
wall out and the shop is open to the weather.

None of that is a rule. It falls out of asking the same question the light
already asks.

### Where it sits, and why there is a gap

The arithmetic, in tiles:

| | |
|---|---|
| a person | 1.18 (`PERSON_H`) |
| eye height in first person | 1.11 (`FPV_Y`) |
| wall top | 2.10 (`WALL_H`) |
| `CEILING_Y` — where an overhead cell's model origin sits | 2.90 (`WALL_H + LIFT`) |
| top of a crate riding a ceiling belt | ~3.07 (`CEILING_Y + BELT_DECK + CRATE_DECK + CRATE_H`) |
| top of a lift basket at the ceiling | ~3.41 (`CEILING_Y + ELEVATOR_BASKET_H`) |

**A ceiling hung at the wall top hides the entire overhead conveyor network.**
That is the one real cost in this feature and it is easy to miss, because it is
invisible in the only view where the ceiling is off: build the ducts overhead,
step into first person, and the thing you paid for is above the ceiling and gone.

So the ceiling clears everything, at roughly 3.5 — and the wall stops at 2.1,
which leaves **1.4 tiles of open air between the wall top and the ceiling**.
That is taller than a person. It is a large band and it has to be dealt with
rather than ignored.

### The clerestory, which is the feature and not the compromise

The gap is what a warehouse, a supermarket and a station concourse all actually
look like: the wall stops, a band of glazing runs above it, and the roof sits
on top of that. Ducts hang *below* the ceiling and are silhouetted against a
strip of daylight — which is precisely how an overhead conveyor reads in a real
building, and it is the one thing in this feature you could put in a screenshot.

It also fixes the thing a flat lid would break. `Lights` already dims a roofed
cell to `ROOF_LEVEL` and buys it back near glass through `openness`, which walks
`this.windows` — panes in *walls*. A clerestory that did not feed that would be
a band of daylight over a room that got no daylight from it: the light and the
picture saying different things about the same building.

Two rules for it:

- **It has to read as glazing.** A gap of nothing between the wall top and the
  ceiling is not a clerestory, it is a roof floating off a building — which from
  inside is a shop whose walls do not reach anything.
- **It has to be in `openness`.** Either as real edge records above the wall
  line, or as a term of its own. A daylight band that changes no light is the
  trap CLAUDE.md names about tiers, wearing a window.

---

## Step 2 — the wall goes to the duct line, and the rest is glass

Built. `Scene.addClerestory`.

1.40 tiles of glass is a curtain wall rather than a clerestory, and it was
tried at full height first: two thirds of the height of the wall under it, in
glass, all the way round the building. So the band is **split at `CEILING_Y`**,
and that split is the whole of the design:

| | | |
|---|---|---|
| 2.10 → 2.90 | upstand, solid, the wall's own colour and thickness | `LIFT` |
| 2.90 → 3.50 | glazing at `GLASS`, exactly as every other pane in the game | `ELEVATOR_BASKET_H + ROOF_CLEAR` |

Both are derived rather than typed, so a taller shaft or a restyled wall moves
the band instead of breaking it.

What that buys is that the two heights stop being unrelated numbers. **The solid
wall stops exactly where the overhead deck begins**, and the glass is precisely
the clearance the lift baskets needed — so the thing you can see from inside is
the thing the roof height was actually about.

### It follows the MASK, not the walls

Same source the slab comes off. Reading `edgesV`/`edgesH` instead would mean
deciding what an upstand does above a doorway, an arch and a curtain — three
answers to a question that has one, since every enclosing opening is solid
masonry well below 2.10 anyway. A cell being indoors with a neighbour that is
not is the whole test.

A **partition gets none**: both sides indoors is not a boundary, so a stockroom
divider stays at 2.10 and you can see over it. That is what an internal wall
does in a real shop, and it is the same distinction `isPartition` draws about
the cutaway one method along.

### The one thing step 2 did not do

**The glass draws and changes no light.** `openness` walks `this.windows`, which
is panes in *walls*, and the clerestory is not one of them — so the room has a
band of daylight in it and is lit as though it had none. That is this repo's own
"a tier that changes no number", wearing a window, and it is written down here
rather than fixed because fixing it is a decision about the **overhead view**:
`openness` is view-independent, so a clerestory term brightens every indoor cell
in the shop whether or not anybody is standing under it — visible change, no
visible cause, in the view you spend nearly all your time in.

Ways it could go, in the order they are worth trying:

- **A term of its own**, flat across the indoor mask, tuned well under
  `WINDOW_SHARE` — a high strip is daylight without a view, and the existing
  `WINDOW_HIGH` already makes exactly that argument about a wall-level version.
- **Real edge records** above the wall line, so the band is glazing the way
  everything else is glazing and `openness` needs no new concept at all. More
  honest, and it puts geometry into `edgesV`/`edgesH`, which is the one array in
  the game everything reads.
- **Leave it.** The room is roofed and the light already says so; the band is
  then a look rather than an opening, which is a defensible thing for a strip
  nobody can reach.

---

## The traps

Each of these is a way for this to be broken rather than to look broken, and
most are already written down somewhere in this repo about something else.

**A roof is a fact about the walls, and enclosure is all-or-nothing.**
`computeIndoor` answers *zero* indoor cells rather than fewer when the shell is
breached, so one accidental delete empties the mask and the entire ceiling goes.
This is the trap CLAUDE.md names three times and docs/belts.md names a fourth —
and it is the one place it is **harmless**, which is worth saying out loud: a
ceiling is a drawing. When `canPlace` hit this it *shed and refunded builds*.
Here, a shop with no enclosure genuinely has no roof, and the picture is right.
Do not "fix" it with a keeping rule copied from the ceiling-duct branch.

**It must cast no shadow.** three.js has no half-shadow — the map is a depth
pass, so a part casts fully or not at all — and a lit plane over the entire shop
floor would put the building in permanent darkness from the sun. Glass and
ghosted walls already opt out for the same reason.

**It is a visibility flag, never a rebuild.** The mode changes on a keypress and
a wheel notch. The precedent is `surroundFar` in `aimSurround`: one boolean per
frame. Rebuilding on `setFirstPerson` would put a rebuild of the shop behind a
key you can press twice a second.

**...but it is rebuilt on every re-flow, and build mode re-flows on every wall
segment of a drag.** It lives under `staticRoot`, which `buildWorld` disposes
wholesale. One merged mesh for the whole mask, the way `collectEdges` merges
every interior line in the shop into one `LineSegments`.

**The ink needs somewhere to go.** A ceiling is the largest single flat surface
in the game, and CLAUDE.md's measured floor is 0.20 linear luminance for a
surface to carry a contour at all. A dark soffit is a hole with nothing on it —
the conveyor family drew with no line for exactly this reason and it read as the
ink pass being broken.

**It must not intercept a ray.** `pickFixture` and `pickFixtureHit` raycast the
art under `staticRoot`. A plane over the whole shop between the camera and
everything else would answer every pick. It is only ever visible in first
person, where you are not building — but "not visible" is not "not raycast", so
it needs to be off the picking path by construction rather than by mode.

**Do not hang the lamps on it.** `emittersIn(fixtures, pieceOf, CEILING_Y)`
already puts hung fittings at ceiling height and they are *props*, in
`actorRoot`. The ceiling is the surface they light, not the thing they belong
to.

---

## What is deliberately absent

- **No pitched roof.** Hips, gables, valleys and dormers are a generator, and
  the only view that could ever show one is the overhead view — where it has to
  be hidden. It would be a system built to be invisible.
- **No roof in the overhead view.** Nothing changes there at all: the shop stays
  the open box it has always been, every screenshot in this repo still matches,
  and the wall cutaway keeps doing the job it does.
- **Nothing to build and nothing to buy.** The roof is not a fixture, not a
  ground design and not a purchase. It is a consequence of having walls, which
  is what the light has always said.
- **No per-room roofs.** There are no rooms — see above. The day `computeIndoor`
  answers more than one enclosure, this becomes a different design.
- **Nothing on the save, nothing in the sim.** A shop played entirely in the
  overhead view is byte-identical, and `simulate` never learns the word.

---

## Proposed

**Step 2b — the clerestory as an authored edge.** The band has a look and no
price and is not in `edgesV`/`edgesH`, which is what keeps it free and is also
why it changes no light. Making it a real edge above the wall line would settle
the `openness` question by having no question in it — see **The one thing step 2
did not do** for the two cheaper answers and the case for neither.

**Step 3 — skylights.** A ground-brush-shaped hole in the mask, or a ceiling
design with `alpha`. The mask is already per-cell, so the layer can carry it;
what it needs is a term in `openness` that is about the cell rather than about
the nearest pane, which today is the only shape that function has.

**Step 4 — the ceiling in the overhead view, zoomed out.** The one case where
another game would draw a roof and this design does not: pulled right back, you
are looking at a building rather than into a room, and `WALL_CUT_VIEW` already
knows where that line is. Worth doing only if the shop from outside ever becomes
a view somebody sits in.
