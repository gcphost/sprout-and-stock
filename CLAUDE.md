# Sprocket & Stock — working agreement

A shop-and-farm game staffed entirely by robots, built by two people at the same
time, each with their own agent, against one shared running world.

The player is the only human who works here. Every hire is a machine — that has
been true of the *art* since workers became content (`server/sim/names.js` draws
staff from a machine register and shoppers from a human one), and as of
the rebrand it is true of the words too. Two conventions follow, and both are
about words rather than code:

- **User-facing text calls them robots.** Hires are a crew, wages are a lease,
  a break is a charge, a tier is firmware. Anything a player reads should agree.
- **Ids, columns and enums are untouched.** `staff-clerk`, `GROUND.break`,
  `T.BREAK`, `wage_mult`, the `workers` table — every one of those is load-
  bearing on a live save or an authored content row, and renaming them buys a
  tidier grep at the cost of everyone's shop. The `wage`/`break` spelling in the
  code is the old name for a thing the player now sees a new name for, which is
  ordinary, and the trap to avoid is "fixing" the mismatch later.

Read this before changing anything.

---

## The one rule that makes co-op work

**Content goes in the database. Behaviour goes in code files.**

| You want to… | Do it via | Why |
|---|---|---|
| Add an item, crop, customer type, event, upgrade | **MCP tool** (`create_item`, `create_crop`, …) | Lands in the live game in ~1s. No file write, so two people can never conflict. |
| Change how a mechanic works | **Edit a file** in `server/` or `client/` | Logic belongs in git where it can be reviewed and diffed. |

Never hand-edit `data/seed/*.json` to add content — use the MCP tools. Those
files are an *export* of the database (`npm run export`), not the source of
truth while you're playing. Editing them directly is the one way to
reintroduce merge conflicts.

---

## Tags are the whole design

Nothing in this game is hardcoded to a specific item. Customers don't want
"tomato" — they want things tagged `produce` + `cheap` + `organic`.

That means a brand-new item automatically gets:

- the right customers (tag affinities in `archetypes`)
- a sensible price (tag-based multipliers in `sim/economy.js`)
- correct spoilage and fixture rules (`shared/tags.js` → `BEHAVIOUR_TAGS`)
- seasonal swings and world-event effects, for free

**Before creating content, call `list_tags`.** An item with invented tags will
exist and never sell — that's the single most common mistake here, and
`simulate` will report it under `deadStock`.

If you ever find yourself writing `if (item.id === 'tomato')` in `server/`,
stop. Add a tag instead.

---

## Two habits that matter

**A wall has two sides, and paint is the first thing that knows it.** A finish
(`PAINT` in `shared/build.js`) is authored as a `surface` exactly as a floor is,
and goes on a FACE — `faceKey` is `o:x:z:±1` along the edge's own normal. Three
things about it are worth knowing before touching either end. The side is a
**number and never "inside"**: which side is indoors is a fact about the shop
that `computeIndoor` re-answers every re-flow, so paint stored as "the inside
face" would swap sides the day you extended the building — the bay-window trap
with a colour on it. It is hung on the **finished** layout rather than handed to
the generator, and that is structural rather than tidy: `ground` has to go in
because a painted cell becomes a different tile, and paint must never have that
power, so a generator that is never told about it cannot have been changed by
it. And `paint-face` answers with the overlay rather than a layout, because a
re-flow is the client disposing its entire scene — `Scene.setPaint` rebuilds the
one group that draws walls, which already stands alone since it is rebuilt on
every quarter turn of the camera. The trap when adding the NEXT kind outside
`FIXTURES`: `selectBuildTool` only sends `build-tool` for things that table
knows, and a kind missing from that guard works perfectly while printing "no
such build tool" on every press — which is why the test is now "is it a
fixture" rather than a list of exceptions.

**A fixture verb can be asked of several fixtures now, and the client sends one
message.** `p.errand`'s four kinds of address are about one thing at a time;
`ids` is the other axis. `targets` in `MartRoom` is the one spelling of "who is
this about" and `Game.bulkFixtures` is the one loop, because the obvious answer —
send the single-fixture message N times — is wrong in three ways that a shop of
six shelves hides. `styleFixture` re-flows (and re-mints the id of what it
touches, so ids captured before the first message go stale under the rest), and a
re-flow is not a repaint; `assignShelf` writes a line per shelf, so one press
becomes one event told six times; and a refusal per fixture is six error toasts
for one click. So: one message, `holdReflow` collapses the re-flows into the one
that was always enough, `logFold` collapses the feed, and only a batch that
changed **nothing** comes back as an error. The rule for adding the next bulk
verb is that a **selection of one must be the old path exactly** — `bulkFixtures`
returns the verb's own result untouched for a list of one, because every ordinary
press in the game now goes through it. **Move is the one that could not be a
`bulkFixtures` verb until the layout learned to forgive a whole group**, and the
reason is worth keeping: `holdReflow` is safe for the other bulk verbs precisely
because none of them moves a tile, so each one's `canPlace` reads a stale layout
that is still true. A shift makes it stale by construction — a row nudged one
square *along itself* has every member landing on the cell its neighbour has not
vacated yet — so `ignoreId` takes a Set now (`ignores`, shared/build.js) and the
batch forgives itself as one. What makes that safe rather than merely convenient
is that a rigid translation is a bijection with no fixed points: no two members
can ever land on the same cell, whatever order they are applied in. It is also
the one bulk verb that is not carried — `p.holding` is one fixture, because hands
are — so the client aims it the way it aims a stamp and sends one delta.
And the client half of the same rule:
`setFixtureRef` clears the selection unless told to keep it, which is what makes
an ordinary tap safe, and every redraw (`showFixture`, `refollowSelection`) has
to say `keepPicked` — a bulk verb IS a re-flow, so a selection that did not
survive one would empty itself the instant you used it.

**After changing anything that touches money — run `simulate`.**
Adding an item, repricing, editing an archetype, changing an upgrade cost.
Balance is invisible from reading code. `simulate` runs 100 in-game days in
about a second against a throwaway world and tells you if you just made the
game unplayable. Use the same `seed` before and after so the comparison means
something.

**After changing anything visual — call `screenshot`.**
The server has no renderer, so `screenshot` asks a real browser tab to render
its canvas and hands you the PNG. Look at it. `stock_shop` first if you want
the shelves full rather than an empty building.

**After touching `layout.js`, `shared/build.js` or an action — run `npm run verify`.**
Thirty sweeps, about a minute:

- `verify:layout` generates ~100k layouts across seeds × counts and asserts the
  generator placed *exactly* what it was asked for, that every fixture has a
  reachable working spot, that queues stay indoors, and that hand-placed
  fixtures land on the tile they were given.
- `verify:build` drives a real `Game` through tilling, stowing, stripping,
  building, moving and selling back, and asserts nothing is created or
  destroyed on the way. It also sweeps `faceAlong` over every legal shelf tile
  × four starting angles, which is the one thing in here that is purely a
  *preview*: a ghost that spins, or that quietly re-derives a facing you had
  already chosen, is invisible in a screenshot and unprovable by eye.
- `verify:edges` walks the real edge rules from the shopper spawn and insists on
  reaching the shop floor, across generated layouts and hand-built rule cases. A
  sealed building fails that and passes everything else.
- `verify:catalog` authors a second design of a kind, a decoration and a lamp,
  then asserts pieces resolve to themselves and that placing a decoration moves
  no tile, no walk grid and no shelf. It cleans up after itself on exit, because
  it writes into whatever content database it is pointed at — usually the live
  shared one.
- `verify:shell` stamps a shop, builds in it and sells out of it, and asserts
  that nothing else moved. That claim is a negative and invisible by eye — you
  would have to notice a shelf you weren't looking at is one tile over.
- `verify:floor` guards the claim the floor layer rests on: that a floor is a
  *look* and never a permission. Two floors of different colours and different
  prices must leave byte-identical `tiles`, `blocked` and `indoor`, or what a
  shop is made of has become a rendering decision. It also asserts the bug
  floors exist to fix, end to end — wall an annex, fail to put a shelf in it,
  floor it, succeed — and that paint survives three re-flows and a purchase,
  because an overlay that didn't would mean buying a shelf repaints the shop.
  Since step 31 it also guards the LOOK THAT GOES UNDER THE JOB, and everything
  in that half is invisible twice over: a stockroom with a floor under it and one
  without are the same cell in the same colour, and the shop afterwards is the
  same shop — only what you own moved. The bug it is the fix for was invisible in
  the other direction and worse for it, because painting over a pad is *also* how
  you move one: a floor dragged across your own stockroom took the storage away,
  the last-cell warning fired and then the thing it warned about happened, and
  what you noticed days later was that deliveries had stopped arriving. Its
  control is the assertion that decides whether any of it is opt-in — a stroke
  that never crosses a pad writes no second layer at all, in a shop where every
  cell of ground already has an entry, which is every save in existence. Its
  centrepiece is a pair worthless split in half: the pad is still a pad AND the
  floor is remembered, since either half alone is satisfied by the stroke having
  done nothing whatsoever. Then: that it is never a PERMISSION, asserted as a
  byte comparison of `tiles`, `blocked` and `indoor` either side of flooring the
  whole delivery bay; that the last-pad warning stops firing for a look and still
  fires for the two gestures that really do take a pad away, or the guard above is
  satisfied by the warning having been deleted; that a scrape REVEALS, paired with
  a pad that has nothing under it still scraping to bare ground; that nothing is
  refunded for a look that went under, since you still own it and it comes back,
  against a circuit up and back that must always lose money; out and back through
  a real world row, which is this file's named-field trap and passes by
  construction today only because `ground` rides in wholesale; and that a REGION
  remove clears both layers, or copy-and-delete leaves a room-shaped stain of
  flooring behind the stockroom it just deleted. Three deliberate mutations were
  run against it — a look replacing the job, a scrape that does not reveal, and a
  pad carrying nothing down — and each was caught on the assertion that names it.
- `verify:yard` guards the delivery bay and the drop-off, which stopped being
  generated furniture and became ground you paint. Four claims, none of them
  visible in a screenshot because a seeded pad and a generated one look
  identical on day one: the yard is stamped ONCE (a boolean on the save, not
  "does this shop own any pads" — otherwise deleting your bay hands it back on
  the next load), a save that predates it gets a yard *and does not move*, how
  big you paint a pad is how many crates it holds, and a pad indoors is walkable
  but never buildable. It authors its own ground rows and removes them on exit.
- `verify:break` guards the break area — the third pad, and the first that holds
  people rather than goods. Its claims are invisible in a screenshot and mostly
  invisible in play, which is why they are here: that a shop with **no** break
  area still takes breaks at the spot the pastime authored (the fallback is the
  whole promise, and the override sits in the same function it falls back to),
  that one cell seats one person so the fifth hire rests elsewhere rather than
  queueing, that a room nobody can reach is not a room — otherwise walling one
  off pins every hire at `TIRED_PACE` forever — and that a break taken in it
  restores more than the same break taken leaning on a shelf, or the room is
  ground you pay for that only costs you the walk. It authors its own ground,
  pastime and worker rows and removes them on exit. Since step 10 it also guards the
  charge a **promoted** unit takes on its own after fifteen seconds with nothing
  to do, which is invisible twice over — a bot in the room because it is worn out
  and one because the shop is quiet are the same still frame, and the two claims
  that matter are about somebody who did NOT go and a charge that ENDED. Its
  centrepiece is that the charge is broken off **before the hire's own deadline**
  rather than before a stopwatch: timed, it passes on a charge that simply ran
  out, which is precisely the bug.
- `verify:economy` guards what a fixture costs and how many of them there are:
  that the price comes off the catalog row and not off an upgrade payload, that
  a build-and-sell round trip always loses money rather than printing it, that a
  discount moves its own kind and nothing else, and that the count is a recount
  of the shop rather than a number kept beside it. Every expected figure is
  arithmetic on a deliberately odd authored price, never on `fixtureUnitCost` —
  asserting a charge against the function that computes it passes whatever that
  function does. It also guards both ladders now that they go *down*: that the
  refund is half of the rung you step off rather than half of the one you land
  on (the other way round, a ladder with dearer rungs at the top is a press),
  that a circuit up and back always loses money, that a fixture keeps its stock
  and its tile on the way down, that a down-step which would leave a unit with
  more on it than the rung below holds — or more KINDS than it has boards — is
  refused **before** any money moves, and that demoting a hire hands back half
  the grade and drops what `payWages` takes the next morning. It authors rows
  into the live content database and removes them on exit, the same way
  `verify:catalog` does.
- `verify:till` guards the checkout ladder, and one claim that is not about
  tills at all: that a record the sim *ticks* and the record build mode *shows
  you* resolve to the same catalog row. `makeStation`, `makeCheckout` and
  `makePlot` each shipped without a `kind` on that record, so `pieceFor` matched
  nothing and `fixtureStats` answered 1/1/1 — the Commercial appliance and the
  Raised Bed both took money for a multiplier nothing ever read, and neither is
  visible in play because the machine still works and the bed still grows. It
  sweeps every fixture in a furnished shop for that. Then: that a rung moves
  *throughput* rather than a stored number (sales over a window, against a real
  queue), that a self-checkout empties its line with nobody in the shop while a
  manual till holds it for ever, that serving yourself is slower than being
  served — or the top rung is strictly better and there is no decision on the
  ladder — and that the takings still land on the counter rather than in the
  bank. And one claim that is about walls rather than tills, because what it
  protects is the queue: that a shop whose walls have been taken out still lays
  a *line* — one tile per place — instead of clamping every shopper onto the
  serving tile. It authors its own pieces and removes them on exit.
- `verify:pens` guards the animal that stopped being a crop, and everything in
  it is invisible twice over: a pen that is filling and one that stalled hours
  ago are the same still frame, and the shop is the same shop afterwards either
  way — only the clock moved. Its control is doubled, because two things have to
  stay opt-in: a shop that never bought a pen (empty list, no tick, no save row)
  and a piece with no `produces`, which is what every fixture row ever authored
  looks like and which must never fill. Its centrepiece is that filling **stops**
  — uncapped, a pen prints goods all night, `capacity_mult` is worth nothing and
  so is the trip out to collect — paired with the claim that a full pen is not
  secretly running, since an animal that stood full since dawn has been standing
  there rather than banking batches. Then the four traps this file already names,
  aimed at this feature: **R**, because `repositionFixture` names every field it
  keeps and a pen's contents deliberately are not among them (they ride a re-flow
  through `carryOver` the way a bed's crop does); the re-flow build mode fires on
  every wall segment of a drag; `elapsed` restarting at zero, so the clock is
  saved as how long it *has* filled; and out-and-back being two different pieces
  of code, asserted through the STORE rather than by handing a `Game` an object —
  the half that shipped missing for five steps when `paint` did it. Plus
  conservation, a roofed pen holding its clock rather than losing it, a deleted
  ITEM being forgiven while a pen with no `produces` is refused (which is
  `harvest`'s split exactly), and a farmhand walking out to empty one. One
  assertion in it is not about pens and earned its place on the first run: the
  pen it just placed must resolve to the piece it asked for, because a refused
  content write leaves the row absent, `pieceFor` falls through to `defaultPiece`,
  and every number in the file is then measured against a shipped pen — which
  fails in twenty places, none of them saying why. It authors two pieces, an
  item, a worker and a world, and removes all five on exit. Since the paddock it
  also guards the herd, and its second control is what decides whether any of
  that is opt-in: a pen with **no** paddock is one head, which is step 1's
  arithmetic to the digit, and every shop in existence is one of those. Then the
  claims a painted field brings — that four times the grazing is four times the
  pace but the SAME stockpile (fold those two and a big field needs emptying as
  often as a small one, which is the decision gone); that a part-painted head is
  worth nothing; that two shelters on one field SPLIT it, or one brush stroke and
  a repeated purchase is a printer that reads as working perfectly the whole
  time; and that a field on the far side of the farm changes nothing, which is
  `dropGoods`' region bug said about grazing, where the paint and the animals
  would otherwise be two unrelated facts on one save. Its centrepiece is the one
  claim in the feature a screenshot could check, and it found its bug on the
  first run: over four hundred seconds no body ever leaves the painted set. A leg
  is a straight line, so an animal picking a cell anywhere in an L-shaped field
  **cuts the corner** — 122 strays, looking exactly like a pig strolling across
  the shop floor between two halves of its own pen, and looking like bad pathing
  rather than like arithmetic. Paired with "at least one of them moved", or the
  claim is about statues. And the CEILING, which is the half that keeps a brush
  stroke from being a printer: grazing is the supply and `heads` on the rung is
  the most a shelter will keep, so all the paint in the world does not beat the
  rung and a better shelter over a small field changes nothing — both halves, or
  one of the two is a knob that takes money and moves no number. Its third
  control is a pen row whose rungs never mention `heads`, which is every pen row
  authored before now: it keeps ONE animal whatever you paint round it, and a
  fourth row exists purely so that "the art is a look" is not asked of the same
  piece — three claims on one control fail as each other. Plus that a re-flow
  **parks** the herd rather than
  restarting it (`parkNow` again, and the reason the bodies live on the Game
  rather than on the layout record a re-flow rebuilds), that nothing about a body
  reaches the save, and that scrubbing the paint puts the pen back to one head —
  the control said backwards.

- `verify:motion` guards the one thing a screenshot can never show: whether the
  thing was moving. That a part flagged `motion` becomes the *right* moving part
  even when a `seam` is dropped past it — the meshes are not the parts, so an
  index taken afterwards spins the box next door and reads as bad art; that a
  spin ACCUMULATES, or a blade eased to a stop drags itself back to where it was
  drawn and the machine appears to rewind; that an idle machine sits *exactly*
  where it was drawn, not nearly; and that a `work` model answers to the batch
  while a `model` answers to the tier, which is the whole reason there are two.
  Since props could be told what the shop is doing it also guards the sweep and
  the signal, which is the same argument pointed at a thing that moves because of
  the WORLD: that a sweep is a pose rather than a loop (a hundred frames of
  quarter past is quarter past), that a hand keeps its distance from its hinge
  and goes clockwise, that a signed `turns` is the far side of a double-sided
  face, that the axis is read off the box so a hand swings in its own face, and —
  the quiet one — that `open` is the shop SERVING rather than the shutters, since
  a sign wired to the shutters reads OPEN all night and looks completely correct
  doing it.
  It writes nothing — every piece it needs it authors in memory, and every
  function it calls is pure.
- `verify:hand` guards the `merchandise` job, which is the first one that takes
  goods back *off* a shelf. Its centrepiece is a claim about a thing NOT
  happening: that a board the hand clears does not come straight back. The crate
  it makes is an ordinary pallet, so `unload` lifts it and `shelve` refills the
  board it came off, and without `giveUpBoard` the whole job is a loop that
  moves stock around a shop and changes nothing — while *looking* exactly like a
  worker doing their job. It also asserts the three vetoes (a reservation, stock
  on its way, the days), conservation of the goods, that your own hands and a
  reservation both overrule the shop having given up, and that a merged shop
  stays merged. It writes one worker row and removes it on exit.
- `verify:park` guards the shopper who *drove*, and its centrepiece is a claim
  about somebody who is not there yet. A car arriving and a car that was placed
  are the same still frame, so nothing in here can be looked at: that a shop
  which never painted a pad is the old game exactly; that there is one lane per
  space and it ends **on** the cell rather than one short of it the way the
  van's does; that a space with no lane is *still a space*, or an animation
  moves `parkReach` and therefore every number in a balance run; that the space
  is held from the tick they set off to the tick they despawn, including the
  drive out; and that a re-flow **parks** a car rather than restarting it —
  building re-flows on every wall segment, so a car that began its approach
  again each time is a customer who never arrives. The one that costs money is
  the patience budget: `stepMood` drains everyone in `this.customers`, which
  since the drive includes people still on the approach road, so it asserts a
  driver arrives at mood 1 *and* that the same seconds spent in the shop do cost
  them. Plus the road: that the border ring cannot be painted, that a drive laid
  out of the bay re-routes the van onto it, that two road designs steer
  identically, and that tearing the tarmac up leaves the lane it had before. And
  the pavement, which is the same claim about feet: given two equally short ways
  the paved one is walked, paving nowhere near you changes nothing, no route ever
  gets *longer*, and a crossing painted across a lane is still drivable.
- `verify:hot` guards the hot counter, and everything it guards is a claim about
  the number THREE. A unit of shelving could be two things, so every stocking
  rule in the game was a boolean — `(itemIsFrozen) === (shelfIsFreezer)`, in six
  files and eleven places — and a boolean is not wrong with a third kind in the
  world, it is *silently* wrong: a warmer reads as "not a freezer", therefore as
  ordinary shelving, so it takes bread and turns away the roast chicken it was
  bought for, while looking exactly like a hot counter. So: that a shop which
  never bought one is the old game to the number (frozen goods still keep in a
  freezer and rot everywhere else, cold is still a favour to a tomato,
  shelf-stable still never spoils); that being in the WRONG special fixture is
  no better than being in none, which a `chilled` boolean could not say — a
  chicken in a freezer used to come back as "where it wants to be"; that the
  nine-way matrix is walked over `STOCK_KINDS` rather than written out, or a
  fourth kind arrives with two of its rules; that the shop's rule and your
  hands' rule are now the SAME rule, in all three places that ask it (the
  chevrons, the press, the staff), which they were not for two steps — see the
  pour below; and that a re-flow drops misplaced stock without destroying it,
  which is what makes a rule change safe to make at all. Its centrepiece is that
  a warmer you built is still a warmer afterwards. It authors one piece and
  removes it on exit, and tags nothing — the items it needs are inputs to pure
  functions, so it builds them in memory rather than changing what the shop next
  door sells.

- `verify:doors` guards the first rule in the game whose answer depends on WHO is
  asking. A signed way through is the same hole in the same wall — same enclosure,
  same price, one painted threshold apart — so nothing here can be looked at, and
  the feature is about somebody who did NOT walk somewhere. Its claims: that every
  set is derived from the one `WAYS` table (a row with the wrong `base` is a
  doorway that stops being a room or a gate that starts being one, and nothing in
  the game would say a word); that a staff doorway encloses byte-for-byte as a
  doorway does; that one edge is refused a shopper, crossed by a hire, and still
  walked by YOU, because `canWalk` is the player's own test; that an entrance is
  crossed inward and not outward, while the same rule between two rooms lets
  everybody through both ways; that a room behind a staff door is still reachable
  by staff, or you have re-created the `TIRED_PACE` pin `verify:break` exists to
  catch; that signing your last way in WARNS rather than refuses, in both
  directions; that the fixture-stranding flood answers identically either side of
  the sign, which is the one claim that is a comparison rather than a value; that
  no place in a queue is ever beyond a ruled opening; and that the refit costs
  nothing in either direction. It authors one floor row and removes it on exit.
  Since the glazed doorway it also guards the first edge in the game with a rule
  AND a look, and the whole cost of a second axis is that the two must not touch:
  pressing Shopfront on a staff entrance has to leave a staff entrance, and
  pressing Staff on a shopfront door has to leave a shopfront door. Both
  directions, because one function reads both axes off the kind in front of it
  and can drop either one — and neither would say so, since a glazed door thrown
  open to the town looks exactly like a glazed door and the sign is a stripe on a
  threshold read edge-on. It arrives days later as shoppers in the stockroom,
  pointing at the pathing. Its money half is docs/building.md §21's own test made
  real rather than asserted against a constant: a look inside the family is free
  (or trying both along a frontage costs half a door a press) and the family
  itself is a purchase (or a doorway grows glass for nothing). And the round-trip
  identity had to learn the axis, which is what it caught on the first run:
  `wayKind` walks the table in order, so asked for a rule alone it answers the
  FIRST row matching it, and every shopfront door resolves back as a fanlight.
- `verify:orphans` guards what happens to goods when the row that named them is
  deleted out from under them. Content is edited live, so an item can stop
  existing while cases of it are on a board, in a crate, in somebody's hands, on
  a shoulder, in a hopper, in a tray and on a van — and every loop in the sim
  that touches stock opens by looking the row up and skipping what it cannot
  find, which is right in each one and adds up to goods nothing can sell,
  shelve, spoil or shift. So it is mostly a sweep about PLACES: six of them, six
  different shapes, and the failure mode is not "the bin is wrong" but "the bin
  has never heard of shoulders", which passes everything else. Its control is a
  second item authored identically, never deleted, and put in all six beside the
  first, because nearly every way of getting this wrong destroys too much rather
  than too little. Two claims are not about places: that a re-flow still
  *forgives* an unknown item while the roll collects it (those two rules must
  not be "unified"), and that a row deleted and put back before midnight costs
  nothing. Plus: pile by pile rather than box by box, the bay coming back, and
  no money moving in either direction. It authors two item rows and removes them
  on exit.

- `verify:bin` guards the first way stock has ever had OUT of the shop, and the
  one claim in it worth keeping is about somebody NOT doing something. A skip
  does two jobs that look like one — you throw away what you are carrying, and
  your crew carry out what has already rotted — and the line between them is
  docs/workers.md's, said about the shop hand: *what something is worth is the
  player's question, and a worker answering it is a worker spending your money*.
  So a hire may take out what is already worthless and may never decide six
  loaves are not worth keeping, which is a claim about a job loop nobody is
  watching: a crate of good bread walked to the tip and a crate of rot walked to
  the tip are the same picture. Its other claims are the `inACar` trap said
  about crates — ten loops walk `deliveries` meaning "stock" and every one is a
  different kind of wrong about rubbish, so there is one spelling
  (`stockCrates`) and three readers that keep the whole list; that a shop with
  no skip is the old game **to the cent**, since rot only becomes a box if you
  own one; that the money does not move either way; that both directions of the
  merge are refused (`dropGoods` into rubbish is the one that would actually
  happen); and the four places a new kind dies quietly — `compose`'s `else` is
  `makeShelf`, so a bin with no branch is not refused, it is silently BUILT AS
  SHELVING. Since the round trip it also guards the flag itself, which is the
  half of "rubbish is a fact about the BOX" nothing was enforcing: `waste` rides
  on the crate and every place a lot is rebuilt out of `lotStacks` is a place it
  can be dropped, since the piles that come out are perfectly ordinary
  `{item_id, qty, day}`. Three did — `liftCrate`, `dropLot` and `beltPut` — so
  the walk to the skip was the one job in the shop you could opt out of by
  *doing* it: pick the box up and it was stock again, at full price, shelvable
  by anybody who passed, with `stockShelf`'s own `p.haul.waste` refusal sitting
  there as unreachable code. The one thing on screen that could have said so
  agreed with the bug, because `syncHaul` never asked either — a crate of rot
  and a crate of stock are the same box in a different wood, and on a shoulder
  they were the same box in the SAME wood. Every claim in it is PAIRED with the
  same gesture made with ordinary goods, or a flag that is always true and one
  that is always false each pass half of it. It authors two items, a piece and a
  worker, and removes them on exit.

- `verify:pack` guards the rung that makes a crate instead of finding one, and
  every claim in it is about a trip that did NOT have to happen — a hire
  carrying a packed box and a hire carrying the box they found are the same
  still frame. The bay it is about is the ordinary one: three part-crates of
  four, where `fit` scores each at four against a six-unit armful, `wholeCrate`
  refuses because four is not more than six, and `fillHands` tops up only the
  kind already in the arms — so a hire leaves with four and walks the shop three
  times, looking busy the whole way. Its control is a rung with no `packs` on
  it, which is every rung ever authored, and that assertion is the one that
  decides whether this is opt-in or a silent change to every save in existence.
  Then: that the cap is the RUNG's number rather than the crate's (or the field
  is a boolean wearing an integer and every rung above 1 does the same thing);
  that nothing is created or destroyed crate-to-crate, which is a new place
  goods can move between and every one of those in this game has been a hole;
  that a packer never packs what no board will take, which is the feature
  working backwards — a full box walked to one shelf and carried home again;
  that rubbish never packs either way round; and that a stray in an aisle is
  never a source, asked of the verb rather than of the job loop because a stray
  carries a 1e6 bonus in `unload`'s own scoring, so a hire in a shop with one
  services it first and there is no stray left by the time any box reaches a
  shoulder. Its centrepiece is the pair that is about SPOILAGE, and it is two
  dodges in one line of `lotAdd`: a merge keeps the *destination's* stamp, and a
  kind the box has not got arrives as a bare `{item_id, qty}` with no stamp at
  all, which `spoilYard` reads as fresh for ever. Either one makes packing the
  way to beat rot, and a crate of laundered flour looks exactly like a crate of
  flour. It authors three worker rows and removes them on exit.

- `verify:spots` guards the claim that WHERE a thing stands is worth something,
  and every one of its claims is invisible twice over: a busy aisle and a dead
  one are the same still frame, and so are a shelf that sells well because of
  its stock and one that sells well because of its spot. Its control is a shop
  nobody has walked in — `spotScore` is 1 everywhere and `arranges` is 0 on
  every rung ever authored — which is the assertion that decides whether any of
  this is opt-in. Then: that footfall is a measurement of the PLACE, so a
  shopper STANDING at a board is not counted (they are there for the stock, and
  counting them scores a shelf highly for holding good stock and then hands it
  good stock on that evidence) and a WORKER never is (their route is the shop's
  own plumbing); that the map survives a re-flow and a purchase, since build
  mode re-flows on every wall segment and a map re-cut each time can never live
  long enough to be read; that it goes out AND comes back, which is the `paint`
  trap and the half that passes for the whole life of the bug; and that eye
  level is one rule rather than three. Its centrepiece is that rearranging
  STOPS — two shelves a hair apart will pass a box between them for the rest of
  the save if a move need only be *better*, which is a hire crossing the shop
  all day, changing nothing, looking exactly like a hire doing their job. It
  authors two worker rows and one world row and removes all three on exit.

- `verify:routes` guards the first thing a worker chooses between that is chosen
  by how far away it is, and every claim in it is invisible twice over: a hire
  walking to the near bed and a hire walking to the far one are the same still
  frame, and the shop is the same shop afterwards either way. Only the clock
  moved. Its control is a rung with no `routes`, which is every rung that
  existed before it — a farmhand stood ON a ripe bed must still walk the length
  of the field to bed 1, because `harvest` and `sow` take `plots.find(...)` and
  a `find` is list order. Its centrepiece is a claim about something NOT
  happening: a near crate worth two units beside a far one worth six, where a
  rung that took the near one to save the walk would be turning one trip into
  three — a balance change wearing an efficiency upgrade, and it would look
  exactly like the real thing. So the stat is only ever offered candidates the
  job rates EQUALLY, and the paired claim is that it does break a tie at the
  bay, or the guard above is satisfied by a stat that does nothing at all. Plus
  the dial, which is the `packs` trap pointed at a float — a field that is a
  boolean wearing a number, every value above zero doing the same thing — so one
  standing spot is offered to a keen rung and a lukewarm one and they must
  answer differently; that a tie keeps the incumbent, which is what makes the
  zero case provable rather than coincidental; and conservation, because
  choosing between two journeys is a place goods could be lost while the choice
  itself came out right. The thresholds are restated in the sweep rather than
  imported, or the dial's assertions pass whatever the constants become. It
  authors three worker rows and removes them on exit.

- `verify:ferry` guards the runner, and the day a back room stopped being only
  the kitchen's. Every case in the shop comes off one dock, so in a big building
  the trip to the far aisle is paid once per ARMFUL — eight hires in single file,
  which reads as bad pathing and is bad logistics. Nothing in it can be looked
  at: a hire walking to a stockroom and one walking to a shelf are the same still
  frame, and a crate that reached the right room and one that reached the wrong
  shelf are both a crate that got put away. Its control is doubled, because two
  things have to stay opt-in — a shop that never marked a room, and a hire whose
  kind predates the directive, which is every kind ever authored. Its centrepiece
  is `ferryTo` surviving `stepStaff`'s haul branch: that branch hands ANY
  shouldered crate to `unload`, which scores a floor board perfectly legal, so
  without the errand the runner does the long walk, lifts the box and carries it
  to the front of the shop — the job reads as working and the rooms simply stay
  empty, which is what a stockroom feature you have not used yet looks like. Plus
  that the range is by NEAREST and refuses what nothing near it wants (or a room
  is a second yard with a roof); that leg B feeds the floor, without which leg A
  is a pile-builder; that the LARDER is not raided, or the runner and the chef
  undo each other all afternoon with both of them correct; conservation, since a
  new place goods move between is a new place they go missing; and relief — a
  room marked back to shop floor mid-carry must not weld the box to a shoulder,
  which is `verify:break`'s `TIRED_PACE` pin arriving through a new door. It marks
  its room through `setBackOfHouse` in build mode rather than writing `boh`,
  because a sweep that sets the flag passes while the real press is refused. It
  authors two worker rows and removes them on exit.

- `verify:pick` guards a verb done to SEVERAL fixtures at once, and everything it
  guards is about the middle of the press rather than the end of it — six shelves
  restyled one at a time and six restyled together are the same six shelves
  afterwards. Its centrepiece is a number that must not grow *and* must not stay
  at zero: `layoutVersion`, which the client watches to decide whether to dispose
  the entire scene. Six re-flows for one press is the cost `setBackOfHouse`
  argues its way out of paying for one flag, and none at all is a shop that
  silently did not update — which is the failure a deferred re-flow introduces.
  Plus: that the batch lands on every member and on nothing that was not picked
  (against a control), that the feed says it ONCE where the single verb writes a
  line per unit, that a bad id in the middle does not stop the rest while a batch
  where nothing worked is an *error*, that a hold does not swallow a re-flow when
  what is inside it throws, and — the one that keeps this from being a tax on
  ordinary play — that a selection of one comes back in the verb's own shape,
  with no fold, no summary and no held re-flow. Since the ladder became bulk it
  also guards the MONEY, which is the half of a batch nothing on screen can
  show: a rung is priced per piece and per tier, so six units at three different
  tiers is six different prices, and a batch that charged the first one's price
  six times comes back with six upgraded fixtures and a shop that is quietly
  poorer, with nothing to compare it against — so the figure is arithmetic on
  the rungs gathered before the run, and its control is that a circuit up and
  back always loses money. Since Remove became bulk it also
  guards the only fixture rule that is a fact about the SHOP rather than about
  the unit, which is therefore the only one a held re-flow can make stale: three
  tills picked in a shop with three each see three still standing, so all three
  pass and the shop is left unable to take money — and the tills being gone is
  what you asked for, so nothing anywhere says a word. Its pair is that two of
  them still go, or the guard is a shop front you can never rearrange, and its
  control is that the last till alone is refused exactly as it always was.
  Since Move became bulk it also guards the first bulk verb that moves a TILE,
  which is the one thing `holdReflow`'s own note excludes: every other verb here
  checks `canPlace` against the shop as it stood before the batch, "which is the
  same shop, since none of them moves a tile". A shift makes that stale by
  construction, and the failure is a *refusal* rather than a wrong answer — a row
  nudged one square ALONG itself has every member landing on the cell its
  neighbour has not vacated yet, so asked one id at a time the shop says no to
  all but the first (measured: 1 of 4, "something is already there"), over a move
  that is perfectly legal. ALONG rather than sideways is the sweep rather than a
  detail of it: the same four moved sideways land on empty ground, no member is
  ever in another's way, and the naive spelling gets all four right — so a sweep
  written that way round passes on the bug. Plus conservation of the goods, a
  delta of nothing being a refusal you can read rather than four members each
  answering "already there", and a shift of one coming back in the verb's own
  shape. It authors nothing.

- `verify:belts` guards the first thing in the shop that moves goods with nobody
  walking, and every claim in it is invisible twice over: a crate that rode a
  conveyor and a crate a hire carried are the same box on the same shelf, and the
  shop is the same shop afterwards either way — only the wage bill moved. Its
  control is doubled, because two lists have to stay empty: a shop that never
  built a belt and one that never built an arm are both the old game, and the two
  new passes must cost them nothing. Then the claims a belt brings by being
  GROUND rather than furniture: it stamps `T.BELT`, blocks nobody, stays walkable,
  and — because a non-blocking fixture is invisible to `blocked` — that stamp is
  the *only* thing refusing a second belt on the square, exactly as `T.PLOT` is
  for two beds. Its centrepiece is **backpressure**, which is one `if` and the
  entire texture: a belt that cannot hand on must STOP, never spill to the floor,
  never merge with the box in front of it, and un-jam the moment the head clears —
  a spill would bury the shop in crates while looking like it was working, and it
  would throw away the one signal the player has. Plus the ordering, which is why
  lines are stepped downstream-first at all: stepped the other way a crate crosses
  the shop in a single tick and a belt is a teleporter with an animation on it,
  while stepped against a snapshot a run drains like a slinky — both read as belts
  being broken and neither is a crash. Since the line rewrite it also guards
  CONTINUITY, which is the only claim in the file about the shape of the code
  rather than about goods and is therefore written as a measurement taken every
  tick: over a straight run, a bend and a junction, each with the jam that used to
  break it, no crate ever goes backwards along its path and none ever steps
  further than one tick of travel. It replaced a claim about `BELT_CREEP_MAX` —
  which was a claim about the per-cell implementation, and that implementation is
  what the four reports were. And the arm, which is where the review effort belongs:
  it obeys the placement rule (`shelfAccepts` to probe, `pourInto` to commit) and
  **exactly one** judgement rule, `givenUp` — asserted as a value each way, since
  "obeys everything a hire obeys" passes every other assertion in the file. One
  claim is about a thing not happening at all: a thousand idle ticks must open no
  boards, because `boardFor` is not a predicate — it calls `openStack`, which
  pushes a real priced board as a side effect of being asked, and an arm would do
  that twenty times a second. Since step 2b it also guards who may put something
  ON one, which is three claims about the same sentence. That a hand posts an
  armful or a shoulder onto a cell and a **second** box is refused, which is the
  one square in the game where "already has a crate on it" is a no. That one
  SWING serves every side — asserted of a single swing against a shelf and a
  freezer, because over a long run both fill either way and the difference exists
  nowhere else. And the pair about the crew, which is doubled in both directions:
  a stocker posts a box onto a run that serves it rather than walking it to the
  shelf, and **never lifts one that is riding** — `unload` scores a crate off a
  pad as a stray, which is a 1e6 bonus, so unfiltered the conveyor works
  perfectly and is emptied by the crew it exists to replace. Its control is
  doubled again for the same reason: no belt at all, and a belt that goes
  NOWHERE, since a hire who read "there is a belt" rather than "the belt serves
  this" would walk every delivery onto a dead-ended run. It authors two items,
  two fixture rows and a worker, and removes them on exit. Since the strip
  curtain it also guards a claim that is a PAIR and is worthless split in half:
  that a crate rides *under* a partition a shopper cannot cross. Either half
  alone is satisfied by a wall or by nothing — and note what it passes for
  today, which is that nothing in `stepBelts` consults an edge at all, so the
  crate crosses because nobody asked. That is exactly why it is written down:
  the day a run respects the walls it passes through, the curtain has to be the
  exception, and there would otherwise be nothing anywhere to say so. And since
  the off-ramp, a second PAIR: that a box set down on a pad lands on the cell
  the loader is TOUCHING, and that none of it turns up on the far island. A pad
  is one named region in as many pieces as you painted it, and `dropGoods` fills
  a region by list order — so a loader beside the fridges handed its box to the
  yard thirty tiles away. That is not a wrong shelf, it is a crate crossing the
  shop instantly, and what it reads as is goods being DESTROYED, because the
  place you were watching is empty afterwards and nothing logs a thing. Both
  halves or neither: a sweep that only counted crates-on-the-pad passes on the
  teleport. Since the farm it also guards the only thing on a run a loader takes
  goods OUT of: a full pen and a ripe bed. Its claims are the empty pen and the
  unripe bed left alone (or "it collects" means "it collects constantly"); the
  pen's CLOCK reset with its `qty`, since `stepPens` pins `filledAt` every tick
  it stands full and a collect that left the stamp would hand the next batch over
  the instant the gate cleared; the bed re-sown with its seed paid for, exactly as
  a hire re-sows it, or the crew and the conveyor undo each other down one row;
  and the 2x2, which is the one that half-works — a pen's record is its MIN
  CORNER, so `covers` and never `x === x`, or a loader against three of its four
  sides finds nothing and you cannot tell which placement you built. Plus the
  WARNING, which is the skip's bug said about the farm: a loader beside a pen
  told it has nothing to work is the one press that automates the walk reporting
  that it changes nothing. And a third, which only EXISTS at a junction with
  three ways out:
  that a split goes to the lines that WANT the box rather than across the
  junction at large. Below three that distinction cannot be drawn — "exactly one
  is keen" and "alternate" cover the ground between them — so two-way coverage
  passes on it for ever. With three, one exit serves nothing (a spur to the
  yard, a line still being built, a column with no loader on it yet), is
  therefore never keen, can never win the single-keen test, and drew its full
  share of the alternation regardless: **4 boxes in 12** down a dead line beside
  two good ones. Every box that arrived arrived correctly, so it reads as a
  sorter that works intermittently, which cannot be told from one that is
  guessing. Paired with "both good lines are still shared", or narrowing the
  pool to a single winner passes the first half and turns the splitter off.
  And since the drag learned to AIM what it crosses, four claims about the one
  number a belt exists to express — a line reversed and a line that ignored you
  are the same picture until a crate goes down it. That a drag back along a run
  you own turns every cell of the ARMED kind, free, in one re-flow; that a
  loader in the same path is still stepped round rather than turned, which is
  the skip's own argument (a loader aims at the shelf it stocks, so a sweep that
  re-aimed it would unhook the aisle while looking like a tidy-up); that the
  cells keep their **ids**, since a crate's address is a cell id and a re-aim
  routed through `placeFixture` would reverse the run and orphan every box on
  it; and the control, which is that a drag saying nothing new is still an
  error — "it aims what it crosses" must not become "every sweep succeeds".
  And since a tunnel's ends stopped being a LOOKUP, §21b — which is one claim
  that is worthless split in half. Asked cell by cell, "is there a mouth ahead
  of me facing my way" makes the middle of a chain an entry AND an exit at once:
  four mouths in a row are three tunnels, and the middle one hands its box
  straight over whatever the run was doing between the two pairs. On the save it
  was found on that was a **lift** — every box that arrived arrived correctly
  and the lift simply never carried one, which is what an unbuilt lift looks
  like too. So pairing is a MATCHING (`tunnelClaimed`): a mouth is an entry only
  if nobody behind it has claimed it, and the answer alternates down the chain.
  Both halves or neither — the near exit hands to the cell in front of it AND
  the far pair is still a tunnel, since a rule that just refused a second one on
  the row passes the first and turns the far one off. The one thing you can SEE
  is the wrong tell: both halves of the middle pair draw as entries, so it reads
  as art that will not turn.
  And §24b, the MERGE said about the square it actually happens on. Who goes
  first where two runs arrive at one cell is a fact about the CELL, and the
  control shipped named against `belt` — a true observation (a merge needs no
  piece bought) that is wrong about where merges happen, because the piece people
  stand where lines meet is the SORTER. So the setting was missing from precisely
  the junction that backs up, and nothing anywhere said so: a sorter with two
  feeders and no merge rule is a sorter, and its menu had one heading fewer than
  the belt beside it. Its centrepiece is take-turns under load, which cannot be
  looked at — a box that went first because it was told to and one that went
  first because it happened to be nearer are the same box on the same cell —
  written as a stream and PAIRED with the same stream under `default`, which must
  take them in runs: a claim that alternating alternates says nothing until the
  thing it replaced provably did not. Its control is the pair that decides
  whether any of it is opt-in (every sorter in every save is `default` and stores
  no field), and its sharp half is the REFUSAL: `straight` and `leg` are read off
  `rot`, which is the direction of travel on a belt and a mouth and is spoken for
  on the other three — a sorter's is its branch, a loader's is the shelf it
  stocks, a shaft's is the side it lands on. The feeder "behind" a sorter is very
  often the LEG, so answering anyway would let the leg through under a row that
  says "let the straight line through", obeyed to the tick and doing the opposite
  of what it reads. Plus both doors the setting can be cleared behind you: a
  re-flow, and R — which is the press this piece gets most of all, since aiming
  the branch is what R is for, and `merge` was missing from
  `repositionFixture`'s named fields from the day it shipped.

- `verify:packer` guards the box that stands still, and it is the only piece on
  a run that changes what is IN one rather than where one is. Every claim is
  invisible twice over: a crate that was packed and a crate that arrived that
  way are the same box on the same shelf, and only the number of journeys moved.
  Its control is a shop that never built one — empty list, no pass, no field on
  any crate. Its centrepiece is a PAIR that is worthless split in half: what the
  machine wants comes out of a box going past, and **the remainder rides on**,
  because a packer that held the arrival until it was empty is a plug that stops
  a run dead the first time you send it something it was never asked for. Then
  the three ways it lets go — full, satisfied, and STALE, which is the one that
  will feel wrong to write and is the only thing standing between this and the
  given-up-board bug with a roof on it. Plus the spoilage stamp riding across
  with the OLDER one winning (`verify:pack`'s centrepiece said about a machine,
  and the same two dodges in one line of `lotAdd`); rubbish never folded in
  either way round; conservation over the whole circuit; and that the CREW do
  not empty it, which is the `inACar` trap in its third form — `floorCrates` was
  a complete description of "a box anybody may lift" until a machine could hold
  one still, and `unload` scores a stray at 1e6. Three of its claims found real
  bugs on the first run, all three of them rules this file already names
  arriving through a new door: `clearRails` lifting the held box (the
  no-resting-on-the-rails sweep turned against its own premise — a packer that
  emits what it was fed, one pile at a time, looking correct throughout),
  `repositionFixture` clearing the tick list on R, and `floorCrates` above. It
  authors two items, two fixture rows and a worker, and removes them on exit.

- `verify:ceiling` guards the SECOND STOREY, and everything in it is invisible
  twice over — a crate that rode a duct and one a hire carried are the same box
  on the same shelf, and a duct four metres up is drawn against a floor the
  camera sees straight through, so a box on the wrong storey and a box on the
  right one are, from a chair, the same box. Its control is doubled: a shop with
  no overhead cell, and the SQUARE, which is the whole pitch — laying a duct
  over a tile must leave `tiles`, `blocked` and `indoor` byte-identical, leave
  it walkable, and leave a belt and a shelf still placeable on it. Which is why
  the second duct on one square has to be refused **explicitly**: there is no
  tile stamp up there and a belt blocks nobody, so nothing else in `canPlace`
  stands between an overhead run and an unlimited stack of them — `verify:catalog`'s
  walk-over invariant, one storey up. Then the one line that IS a second storey,
  asserted as two runs crossing over one another travelling opposite ways with
  neither box ever changing deck. Its centrepiece is the LIFT, which is two
  claims a still frame cannot separate. That its direction is derived from
  whoever feeds it — including a **loader**, which is the case that could not be
  answered while it was resolved inside `conveyorFlow`'s own seeding loop
  (asking a derived cell there is unbounded recursion and it took the server
  down), so a shaft at the end of a duct always guessed "up" and what that reads
  as is a box that will not come down. And that a crate part way between storeys
  is **over the shaft's own square**, sampled every tick, in both directions —
  going up it always was, and coming down it stepped off the end of the duct
  into thin air, because the riser was put on the near cell rather than on the
  lift. Half of that looks perfect, which is why it lasted. Paired with `dist`
  and `pts` measuring the same journey, since they were built by two pieces of
  code and disagreed by exactly the riser: charged and never drawn, so the box
  was handed two tiles of travel for a leg 1.41 long and cut the corner anyway.
  Then the T, which is the report it was written for and is two claims — that a
  junction overhead hands boxes down both branches, and that **not one arrives
  downstairs**, asserted against a decoy run laid on the floor straight through
  it. Every way out of a junction is a hand-off between two LINES, and the
  lookup that turns one back into a cell defaults to the floor: with nothing
  underneath, the box parked for the rest of the save; with the ordinary build
  underneath, it dropped four metres and carried on being a perfectly ordinary
  crate. Plus the overhead loader reaching the same four floor neighbours as a
  floor loader (`armReach`, the one spelling, because five loops enumerate a
  loader's sides), with the crate travelling out and then down that L-shaped
  spur; a re-flow and an **R** press keeping the storey; and conservation. It
  authors one item and four fixture rows and removes them on exit.
  Since step 9 — the same square being a way OUT rather than only a place to be
  — its sharpest control is that **the rise is CHOSEN**. Up is a fifth exit, and
  the moment one exists the two networks the file's own section 3 keeps apart can
  touch by default: laying a duct across the shop would silently join it to every
  run it crossed. So a plain belt never looks up, a loader with a run in front of
  it never looks up, and the only two that do are a junction — the piece whose
  whole job is choosing between ways out — and a loader that has run out of
  aisle. All three are asserted in one shop that differs by nothing else — and
  again in a row made ENTIRELY of loaders, which is the shape "belts on the
  corners, loaders down the straights" produces and the one that found the hole:
  a beltless row never reaches the forward walk, so its endcap was declared a
  terminus by step 2's "a loader emptying into a unit hands on to nobody" one
  line before anything asked about the rise. Same build, working or not
  depending on whether there happened to be a belt upstream. Then
  the ENDCAP three ways, which is the ladder in `armSwing` rather than a
  behaviour: a duct over it and the box goes up, no duct and it comes off onto
  the ground exactly as it did, a shelf in front and the shelf is stocked with
  nothing rising at all. Below the ground drop that rung would be dead code in
  every shop, because every loader in every shop has walkable floor beside it —
  and it turns out to outrank a PAD too, which the sweep found by accident. Plus
  the pair at a junction, worthless split in half: a sorter sends what nothing
  wants up, and a line that WILL take the goods still outranks the rise, or it is
  the `homeFull` spread bug wearing a storey with every box that arrived having
  arrived correctly. And no COLUMN — two cells over one square are the most that
  can exist and the one thing they must not be is a run, since unguarded the
  floor cell hands up and the ceiling cell hands down for ever, which neither
  errors nor spills — paired with a ring that changes storey twice, because a
  return leg that only goes up is a way of losing stock on the roof. Its section
  7 had to MOVE for this and the move is the interesting part: the decoy floor
  run used to lie under the ceiling junction's own square, and that square is now
  a way out, so it stopped being a decoy. The claim survives because the bug it
  guards is a *lookup* — the decoy sits under the two EXITS now, which are the
  squares those lookups name.

- `verify:paint` guards the same claim `verify:floor` makes about the ground,
  said about the other surface in the building — and it has to be made again
  rather than inherited, because paint goes somewhere nothing had gone before:
  on ONE SIDE of the line between two cells. Everything that reads a wall reads
  it as a number in `edgesV`/`edgesH` — enclosure, pathing, the queue, who may
  cross — so a finish that touched either array would not be a rendering bug, it
  would be a shop that changes shape when you decorate it. Its centrepiece is
  therefore a comparison rather than a value: every wall in a furnished shop
  painted, and `tiles`, `blocked`, `indoor` and both edge arrays byte-identical
  afterwards. Plus the claims a SIDE brings with it: that painting one face
  leaves the other bare (a key that dropped the side would paint both and look
  perfectly correct from a camera that can only see one of them), that it
  survives the re-flow a purchase causes and **causes none itself**, that a face
  with no wall is refused while a drag ALONG a wall skips the gaps, and that a
  repaint hands back half of what was under it so no amount of redecorating
  prints money. It authors two paint rows and removes them on exit.

- `verify:price` guards the claim that what the shop charges is a fact about the
  ITEM, and every assertion in it is a number that looks identical whichever way
  it was decided — a board priced by you and a board priced by the shop are the
  same board with the same figure on it. A price has lived on `stack.price` since
  there were shelves, set once from `suggestedPrice` as the board opens, which is
  right about a shop with one shelf and quietly wrong about every shop bigger
  than that: eggs on three units is three prices, and the fourth board to open
  says the suggestion back at you. So `orders.items[id].price` is the standing
  answer, beside `min` and `max`, on the same argument step 3 of docs/ordering.md
  makes about those two. Its centrepiece is the **refill**: `pourInto` re-prices
  a board that had emptied, so a standing price honoured by `openStack` alone
  holds only until the shop sells out — and what that reads as is a number
  resetting itself days after you last touched it, with nothing to connect it to.
  Plus the control that decides whether this is opt-in or a change to every save
  in existence (no rule ⇒ `itemPrice` **is** `suggestedPrice`, to the cent, and
  the rule map is still empty); that setting one lands on every board holding it
  and on **nothing else**, asserted against a second item standing next to it,
  because nearly every way of getting a reprice wrong moves too much rather than
  too little; that clearing it hands those boards back to the suggestion, or the
  dash means "the last number I typed, for ever"; that **zero is a price**, since
  `min`/`max` spell unset as `<= 0` and giving something away is not the same
  sentence as never having said; and that nudging a minimum reprices nothing,
  which is what keeps the shelf menu's per-board price from being wiped by a
  patch that never mentioned one. It authors nothing at all.

- `verify:boards` guards the first arrangement in the shop that is a DECISION
  rather than a record. Where goods sit on a unit was the order they happened to
  arrive in — `openStack` pushes a new kind onto the end — and that order is what
  the shelf is drawn from, so the one arrangement you can see from across the
  shop was filed by delivery date. Its centrepiece is that BOTH lists move:
  `syncShelves` files a kind by its place in the union of `assigned` and
  `stacks`, reservations first, so a reorder that moved only the goods draws the
  shelf exactly as it drew it before — the menu says one thing and the shop says
  the other, which reads as the drag not having worked in a shop where it
  demonstrably just did. Plus that it is a permutation to the penny and the
  spoilage stamp (a sort is a place where a lost element is one missing row
  nobody counts); that a list naming something the shelf has not got, or naming
  one thing twice, moves what it can and conjures nothing; that whatever it does
  NOT name keeps its place at the end, because a delivery can land between the
  press and the release; and that every refusal comes before anything moves. It
  authors nothing.

- `verify:order` guards the difference between a refusal YOU get and a refusal
  the CREW get, which is one line of `restock` and was the whole reason a big
  shop read as understocked. `buyStock` turns down an order bigger than
  `bayRoom` or `looseRoom` **by name** rather than shrinking it — right about a
  press you made, since a number silently becoming a smaller number is the
  complaint said backwards, and the message tells you to paint more bay. It is
  exactly wrong for a job that CHOOSES the number, because both buying paths
  read a refusal as `continue`: the board is skipped, and skipped again next
  tick, and every tick after, since nothing about it has changed. What that
  inverts is the sharp bit — the emptiest board asks for the most, so **the
  bigger a unit is, the more certain it is never to be bought for**. A live shop
  on day 322 had a 216-unit stockroom board at zero against a bay with 60 free:
  the buyer computed 216, was turned down, and moved on for ever, while every
  small old shelf beside it had stock on it. Buying more shelving made it worse;
  painting a bigger stockroom made it worse; the one thing that would have
  helped is a bigger bay, and nothing anywhere said so. It is invisible twice
  over — no refusal reaches the feed, because `buyStock` only logs for
  `!p.staff`, and a buyer who was refused and a buyer with nothing to buy are
  the same still frame — so it arrives days later as shelves that will not fill,
  pointing at the staff. Its control is that an order which already fits is
  untouched to the unit, which is the assertion deciding whether this is a bug
  fix or a silent rebalance of every save in existence. Its centrepiece is a
  pair worthless split in half: a too-big board is ordered for **at all** (the
  number was zero, not wrong), and no single van exceeds the bay (satisfied by
  ordering nothing, which is the bug). Then the one that makes reserve depth
  real — that the clamp is a **rate and not a ceiling**: land the van, ask
  again, and the board fills to its own capacity over successive runs, because
  `homeSupply` counts a pending order. Plus a yard with no room ordering nothing
  and spending nothing, and the money being what was ordered rather than what
  was wanted — a clamp applied to the quantity and not to the charge is a shop
  that is quietly poorer, with crates that arrive looking perfectly correct. It
  authors one worker row and removes it on exit.

- `verify:store` guards the claim that `server/db.js` became a *contract* rather
  than a file: that a shop kept in SQLite and a shop kept in a browser are the
  same shop. Every assertion in it is a comparison run against both stores in one
  breath, because a value would only ever tell you what one of them does — and
  the failure it exists for is not a crash. The sim reaches the store through
  nineteen functions and nothing else, so a web store that is subtly wrong hands
  back a catalogue with a field missing or a modifier list that keeps a row a day
  longer, and what you get is a shop that plays *slightly differently in a
  browser* with nothing anywhere to say so. Its centrepiece is the rows
  themselves, and it earned its place on the first run: `npm run seed` does not
  copy JSON into a database, it calls `writeContent`, and a zod parse fills in
  every default the schema declares — so `data/seed/*.json` is a MIXTURE, rows
  re-saved since a field was added carrying it and rows untouched since not.
  Read raw, the web store handed out `alpha: undefined` for some items and `1`
  for others off the same committed file, with the split decided by which rows
  somebody last edited: ninety rows differing in `model`, `tiers` or `surface`,
  none of which would have crashed anything and all of which would have drawn
  slightly wrong. The fix is that the web store parses through the same schemas,
  so the two agree by construction. Its other claim is **durability**, which is
  the only one about something that has not happened yet — everything else
  passes against a store that never writes to its vault at all, so it throws the
  whole store away and reads it back, including that a *deleted* world stays
  deleted and that modifier ids keep climbing across a reload. It seeds a
  throwaway SQLite file under the OS temp dir via `SNS_DB` and removes it on
  exit; the live database is never opened.

- `verify:host` guards the claim `ShopRoom` was split out of Colyseus on: that
  the shop rests on ten calls and nothing else. That claim is worth nothing until
  something other than Colyseus answers those ten, because a seam with one
  implementation is a seam that *compiles* — every other sweep in here drives
  `Game` directly, so not one of them has ever touched a room, a client or a
  frame. So this drives the whole room over `ChannelHost`: a real shop, a real
  20Hz tick, real clients on real channels, no socket anywhere. Its centrepiece
  is a claim about something that must STOP — a room that leaked its tick goes on
  simulating a shop nobody is in, which is the same empty picture either way, and
  arrives eventually as a world that quietly rolled forward a day while nobody
  was playing it. Plus the two **swallows**: an unknown message type and a
  handler that throws are both survivable on the Colyseus side, so if either took
  the room down here the same bug would be a glitch on the desktop build and a
  dead tab on the web one — which is the divergence the seam exists to prevent,
  arriving as "it works on your machine". And one about ordering that reads as
  pedantry until it isn't: arrival is *addressed* rather than announced, so a
  second person joining must not re-send the first their `you` or the catalog.
  Since co-op it also guards the half of a peer connection that is not a
  network: a channel is `{post, onFrame, onClose, close}` and `linkedChannels`
  is one, so a second guest arriving, two guests being told apart, one of them
  dropping **mid-carry**, that same drop by a guest the shop has met before —
  nothing on the floor, the record under their own `who`, the armful and the
  spot handed back on rejoin — and a shop closing *under* whoever is left are
  all ordinary calls on a room. That last pair is the point — for a while nothing
  detected a wire going away at all, so a guest who closed their tab stayed
  standing in the aisle holding stock nothing could ever get back, and the host
  who closed theirs left a guest looking at a photograph of a shop. What it
  cannot reach is SDP, ICE and the 48KB message cap, which are manual and listed
  as such in docs/browser.md. It authors one world row and removes it, its save
  and its modifiers on exit.

- `verify:spawn` guards the first thing an event can move that is not goods.
  `demand_mult` and `price_mult` are both facts about the shelves, so no event
  could ever change WHO walks in — a school holiday and a goth night were the
  same sentence said at the same twenty archetypes in the same proportions.
  Everything in it is invisible twice over: a shopper who came in because of an
  event and one who came in anyway are the same person in the same doorway, and
  a crowd is only a crowd in aggregate, so no still frame of a shop tells a
  takeover from a run of luck. Its control is doubled and is the assertion that
  decides whether this is a feature or a silent rebalance of every save in
  existence — and it is not "the same shopper comes out", it is **the stream is
  in the same place afterwards**: `rng.weighted` asks `next()` once whatever
  list it is handed, so the multiplier is folded into the WEIGHTS and the draw
  stays one, where rolling the crowd and then rolling the shopper would be two
  and every balance figure in this repo would stop being comparable. Doubled
  because no modifiers at all and an ORDINARY demand/price event are different
  paths through `foldModifiers`, and the second is the one every existing save
  is actually on. Then the pair that is worthless split in half: an effect
  naming a `tags` entry moves that shopper and an effect naming an archetype by
  **id** moves nobody — either half alone is satisfied by nothing happening at
  all — plus the untagged archetype, which is every row written before `tags`
  existed and may only ever be diluted, never selected. Plus that a tag nothing
  carries is inert, which is what lets one `effects` array hold two vocabularies
  (`demand` already does it with a tag nothing stocks); the product over several
  tags; that **zero is a real answer** and yet zeroing the whole town still
  hands back a shopper, since `spawnCustomer` is the only door into
  `this.customers`; and the fold — one event's duplicate rows are its strongest
  pull rather than 2×2×2 (a restart or a double `run_director` is exactly how a
  pile of identical rows happens), different events do compound, the band holds
  however many pile on, and a row written before the column existed reads as 1
  while the fold still takes the strongest pull on demand. The band is restated
  rather than imported, or every assertion passes whatever the constant becomes.
  It authors three archetypes and removes them on exit. Five deliberate
  mutations were run against it before it was believed — an extra rng draw,
  matching on the id, summing the tags instead of multiplying, stacking the
  duplicates, and deleting the band — and each was caught on the assertion that
  names it.
- `verify:grace` guards the first five days, and its control is the assertion
  that decides whether the whole thing is opt-in: a shop past the ramp is the old
  game **to the digit**, on every cause, in both directions — every save in
  existence is played well past day 5, so a control that is wrong has quietly
  rebalanced all of them. The rest is about a still frame that cannot be looked
  at, because a shopper who stormed out of a day-1 shop and one who stormed out
  of a day-10 shop are the same picture and the shop afterwards is the same shop;
  only the slowest number in the game moved. That losses are discounted and
  **gains never are**, which is the entire feature — a shop that cannot climb on
  day 1 is one that cannot dig itself out, and scaling both directions is the
  more elegant sentence that makes the opening week inert. That `R.SETTLED` is
  untouched, or the spring holding a new shop off the floor is throttled by the
  thing protecting it. That it is a RAMP rather than a flag, asserted as three
  distinct days AND as their specific values, since "strictly increasing" is
  satisfied by a curve that is 0.99 on day one — the `packs` trap said about a
  divisor. That the discount is applied over `REP_CAUSES` rather than a
  hand-written list, which is how an eighth cause becomes the one that still
  craters a beginner while passing every other assertion in the file. And that
  the **receipt** banks what landed rather than face value, because the report's
  total is arithmetic on its own bars and a discount applied to the number but
  not to the breakdown explains less than all of the movement — on exactly the
  days a beginner is reading it. It restates the ramp rather than importing
  `GRACE_DAYS`, or every assertion passes whatever that constant becomes. It
  writes nothing at all: no content rows, no save, no cleanup.

- `verify:undo` guards the one thing in build mode that is meant to leave no
  trace, and every claim in it is invisible by construction: a shop you never
  touched and a shop you built in and undid are the same still frame — that IS
  the feature — so a correct undo and one that quietly ate a shelf's stock are
  the same picture of the same aisle. Its control is the assertion that decides
  whether any of it is opt-in: `recordUndo` writes nothing unless a step is open
  and only a build message opens one, so the generator, the balance bot, MCP and
  every other sweep in here must record **nothing at all** — a control that is
  wrong is `simulate` growing a stack of sixty days of purchases and every sweep
  measuring a shop carrying a second copy of its own history. Its centrepiece is
  the shape this could most plausibly have been built in and must not be: the
  building is four plain arrays, so undo *looks* like a stack of snapshots, one
  assignment each — and a fixture's stock lives on the layout record under an id
  `repositionFixture` re-mints on every move, so restoring the array brings the
  shelf back at its old id with the loaves filed under the new one. Goods
  destroyed, nothing logged, discovered as a shop that is poorer four presses
  later. So: stock it, move it, undo, count. Plus that a drag is ONE entry
  (`buildEdge` writes eight segments itself and `buildRun` calls `placeFixture`
  twelve times, and eight presses of Ctrl+Z for one press of the mouse looks
  exactly like undo working); that the money comes back in FULL rather than at
  `FIXTURE_REFUND`, that a round trip is worth zero, and that it is a **delta**
  — earn between the press and the Ctrl+Z and the takings must survive it; that
  a refused press pushes nothing, or every no sits on top of the stack as an
  undo that does nothing; that a step with a blocker is refused **whole**, since
  half an undo leaves a shop that is neither state with no entry left to retry;
  that a new press forgets the future; that undoing a hole in a wall the SHELL
  drew leaves `edits` empty rather than an entry saying "wall", which draws
  identically until the shop grows; that paint comes back **without a re-flow**,
  which is `verify:paint`'s claim said about the way home; and that a removal
  comes back as itself rather than through `placeFixture`, which mints tier 1 —
  a demotion nothing logs, wearing an undo. Since Move became bulk it also
  guards a step that moved SEVERAL units at once, which is the "all or nothing"
  rule above turned against itself: every fixture step until then held one unit
  or twelve being built from nothing, so no part was ever standing where another
  part was going. `couldGoTo` asks `canPlace` of each against the shop as it
  stands, the deferred re-flow means that shop still has the whole row where it
  was, the parts refuse one another — and because half an undo is worse than
  none, the whole step is refused. You press Ctrl+Z on a move you made a second
  ago and the shop says "something is already there" about the shop it is being
  asked to go back to. Its pair is REDO, since one walk runs both ways and a fix
  applied to one direction would leave the other refusing. It writes nothing at
  all.

- `verify:stamp` guards the two gestures that put down several fixtures at once,
  and every claim in it is invisible in a still frame by construction: six
  shelves laid one at a time and six laid in one drag are the same six shelves,
  and the shop is the same shop. Only the number of presses moved. Its control
  for the ROW is a conveyor — every run ever laid — where each cell turns to
  follow the drag because a belt's rotation IS its direction; its centrepiece is
  the opposite claim about everything else, since a row of shelving that swung
  round at the bend is an aisle you cannot walk and would look perfectly correct
  in a screenshot of the straight part. Both sides of `runFollows` are asserted,
  or the sweep passes on a flag that is always false. Its control for the STAMP
  is a shop that has copied nothing: paste refuses, builds nothing, costs
  nothing. Its centrepiece is the three things a blueprint deliberately does NOT
  carry, each of which is a way to print money — the **stock** (a paste that
  conjured the six loaves off the shelf you copied is free goods once per press,
  looking exactly like a paste working), the **tier** (a copied Commercial
  freezer pastes as a basic one, because `placeFixture` charges the base price;
  the other way round sells the whole upgrade ladder at a discount you can run
  with two keys), and the **ids** — while the *variant* does come with it, which
  is the pair: a shape is free and a rung is not, answered differently by one
  call. Since the region it also guards the layer a blueprint of a ROOM could not
  carry, and its control there is the assertion that decides whether any of it is
  opt-in: a copy with no region is the old game to the cell, which is every
  selection anybody clicked together rather than dragged. A selection is a list
  of fixture ids and ground has nothing to be picked *by* — no id, no record,
  nothing to hang a ring on — so the box was whatever the units happened to span,
  and a room's ground is exactly what lies between and beyond them: a stockroom
  is shelving round the edges and Storage painted out to the walls, and a break
  area has no units in it at all. Its centrepiece is therefore the pure-ground
  case, which the fixture path can never reach — nothing picked, four squares
  copied, stamped, and taken back in one press. Paired with the ANCHOR, which is
  the half that fails silently: every layer is relative to the region's corner,
  so a preview still anchored on the fixtures' corner draws the stamp up and left
  of where it lands by however far the drag reached past the shelves, which is a
  blueprint that builds the right thing in the wrong place. And that the shell's
  own ground stays behind the way the shell's own walls do — `freezeYard` writes
  a pad with no `piece`, and an empty piece IS the bulldozer, so a copied
  delivery bay would paste as a hole scraped in the destination's floor. And
  since Remove learned about the region, the SYMMETRY, which is written as a
  comparison rather than a value because that is the whole of what it guards:
  what `copyFixtures` says it would carry, against what `removeSelection` took.
  The gesture is copy the room, stamp it the other side, delete the original —
  and a remove reaching one cell shorter than the copy leaves a room-shaped
  stain (floor still painted, pads still pads) that reads as delete not working
  on ground, while passing any assertion written as a count. `selectionRegion` is
  one function for exactly that reason. Paired with the circuit, which is what
  stops copy-and-delete printing money. Plus the
  ORDER, which is where it found its bug on the first run:
  `holdReflow` around the whole paste leaves `canPlace`, `canPlaceEdges` and
  `canPaintFaces` reading the layout as it was before the first cell, so a stamp
  of an aisle onto bare grass refuses every shelf in it and then reports "none of
  that would go there" over ground it laid a moment earlier. One hold per LAYER
  is the fix. It writes nothing at all.

- `verify:emote` guards the first thing one body in the shop ever said to
  another, and it is the counter-example to this list's usual argument: an emote
  is the most *visible* feature in the game — an arm goes up, and a screenshot
  settles it. Everything it must NOT do is invisible, and each of those draws
  perfectly. Its control is that a shop where nobody has waved sends the frame it
  always did, asserted as `'emote' in p` rather than as a truthiness test,
  because the failure is a key that is always present and usually null — bytes
  about nothing, ten times a second, in a shop of eighty people. Its centrepiece
  is the STREAM: eight shoppers waving back is eight chances to draw a dither
  out of `this.rng`, and one of them doing so would make two `simulate` runs
  either side of *adding a wave* diverge with nothing in the output to say why.
  So the stagger is `hash01`, which is the kit's own argument, asserted from
  both ends — the stream is where it was, and the same shopper always gets the
  same beat. Then: that it STOPS (a pose expired against `elapsed`, or the arm
  is up for the rest of the save, which is not obviously a bug on a robot); that
  it reaches the save **not at all**, since a stamp against `elapsed` restarts
  at zero on every load and would land the pose in the future — the trap
  `plantedAt`, `yieldedAt`, `bornAt` and `arrivesAt` have each sprung; and that
  it is a vocabulary, swept over the shared table rather than written out, so a
  fifth emote is covered the day it exists. Its sharp half is the wave-back, and
  the sharpness is that **every one of its rules is satisfied by the feature not
  working at all** — "nobody far away answers", "a dancer is not answered",
  "somebody mid-wave is not restarted" all pass in a shop where nothing ever
  waves. So each refusal is PAIRED with the thing it refuses actually happening,
  in the same shop, in the same breath, including the `inACar` rule arriving for
  the fifth time as an arm out of a moving windscreen. It authors nothing at
  all: no content rows, no save, no cleanup.
  Since a greeting started cheering people up it also guards the only thing in
  the game that moves a shopper's patience **upward for free**, and every claim
  about it is a bound rather than a value. `mood` is what a visit's reputation
  is priced against, so an unbounded greeting is a reputation printer you run by
  holding a key — and none of it can be looked at, since a shopper who was waved
  at and one who simply had a good day are the same person leaving the same
  shop. Its centrepiece is the **once**, asserted across a whole visit rather
  than across one tick: a flag on the shopper rather than a stopwatch, or the
  bound is a rate limit you would be right to grind. Then that it is paid where
  the greeting LANDS (`answerWave`) and not at the press, which is what a
  too-far and an in-a-car shopper are there to prove — paying in `emote` would
  pay for waving at an empty aisle, and the mutation that does it fails four
  assertions at once. Plus the ceiling, since `moodBase` puts a shopper at 1 in
  a lovely shop and a mood above it prices a sale above its own maximum; that a
  HIRE is not quietly given a `mood` field, which `moodAverage` and `stepMood`
  would both find and believe; and that no reputation or cash moves directly.
  ⚠️ **`simulate` is blind to all of it** — the balance bot never emotes, so a
  before/after reports no change because nothing waved, which is the instrument
  being blind rather than the change being free. These assertions are the whole
  of the guard, and `WAVE_MOOD` carries the argument for the number.

- `verify:face` guards seven boxes on a head, and its argument is the one
  `verify:emote` makes inverted: a face is about eight pixels in an ordinary
  frame, so every way of getting it wrong draws as *a face*. A shopper whose
  brows never move, one whose brows move the wrong way, one who never blinks and
  one who blinks in perfect time with the other nineteen are all, in a still
  frame, a small cream-coloured head. Its centrepiece is that the brow angle
  **flips sign**: the art is authored outer-end-down, which is a faintly
  concerned resting face, so a scowl has to reverse it and a grin has to FLATTEN
  it — and the obvious way to write that, one signed term carried through zero,
  gives a delighted shopper the resting slope twice as steep, which is a
  *pleading* face worn by everybody having a nice time. It shipped that way and
  this caught it. Then: that `write` is PURE, recomposing each matrix from the
  authored numbers rather than adjusting the one it finds — the mutation walks a
  brow from 0.728 to 0.872 over six hundred frames, which is art that is fine
  when you look at it and broken when you come back; that the blink happens, and
  closes, and is rare, since each of those is satisfied by the wrong answer to
  the other two; that two people never blink on the same frame in a minute; and
  that nothing leaves the head at any expression, which only ever shows up in a
  shop already having a bad day. Its control is the pair that says who this is
  opt-in for: a body with no batch (every hire with authored art — `trim` is
  WELDED in the mesh path, so there is nothing in there to move an eyebrow of)
  is untouched and is not even given a signature, and a body with no mood — you,
  and every hire — is the authored art to the digit, because patience is a
  shopper's resource and a shopkeeper's face reporting one would be showing a
  number that does not exist. Plus the one claim that is about a function
  choosing NOT to run: a matrix vandalised between two frames of an unchanged
  expression must still be vandalised afterwards, which is the only honest way
  to observe the early-out that keeps eighty faces free. It writes nothing at
  all and touches no database — every body it needs it authors in memory, the
  way `verify:motion` does.

- `verify:reveal` guards the palette that unfolds, and everything in it is
  invisible by construction: a shop whose conveyors have not turned up yet and
  a shop that never had conveyors are the same screenshot of the same bar, and
  the shop afterwards is the same shop — only what you can FIND moved. Its
  control is doubled, because two populations have to come through untouched: a
  save that has never heard of the field (`reveal` absent ⇒ false ⇒ every tool,
  exactly as the bar shipped, which is every shop in existence), and one that
  has deliberately switched it off — asserted with the cache signature as well,
  or a shop that opted out rebuilds its whole palette every time a rung ticks
  over. Its centrepiece is the rule that reading the table cannot check: **a
  gate may never be the thing it gates.** Five rungs of the ladder measure
  HAVING BUILT the thing — `first-kitchen` is "put an appliance on the floor",
  and `break-room`, `car-park`, `stockroom` and `first-warmer` are the same
  shape — so gating `station` behind `first-kitchen` is a button that appears at
  the exact moment you no longer need it to, which is a feature that is off for
  ever while every id resolves, the table reads as sensible and nothing errors.
  So it is asserted EMPIRICALLY rather than against a banned list: for every
  gate, standing the gated kind up in a shop must not move the gating
  milestone's own measure, which cannot go stale the way a hand-written list
  would the day somebody writes a forty-sixth rung. Then: that a reveal is not a
  PERMISSION, since MCP, a sweep, the balance bot and a co-op guest whose bar is
  further along all send builds the local palette would not have offered — the
  day `placeFixture` consults this, every one of those breaks; that unlisted is
  VISIBLE, which is the safe direction, or a fixture authored tomorrow prices,
  places, renders and can never be found; that exactly one rung opens each tool,
  swept against every OTHER rung being earned; that it is a ladder rather than a
  switch, or the table is a boolean wearing a milestone id and the whole bar
  arrives at once; that nothing the TUTORIAL points at is gated, which is the
  claim that found the one real bug here and is a NEAR miss rather than an
  obvious one — `client/tutor.js` names palette entries by selector, its `hire`
  step is done on `roster.length > 0` and `first-hire` measures exactly that, so
  gating the chiller behind the hire is almost right and fails only on the race
  against a 1Hz milestone sweep, which is an intermittent tutorial bug found by
  the people least able to name it; and out and back through `serialize`, `saveState` and the
  create payload, which is this file's named-field trap and the half that bit
  `paint` for five steps. Its last claim is that turning it OFF is not one-way —
  `done` goes on climbing while the ladder is off, so a shop that unlocked
  everything on day 40 and changed its mind on day 41 gets back the bar it had
  earned rather than the opening four buttons. That falls out of gating on
  `milestones.done` rather than on a list of what has been shown, and is the
  whole reason no such list exists. What it cannot reach is the client filter:
  `client/sections.js` pulls the audio manifest, so `computeBuildTools` is
  unloadable in node, and the two claims that live there are written down rather
  than skipped quietly — the cache key (a rung landing must invalidate
  `toolCache`, or the bar grows no button until somebody authors content, which
  reads as the reward not having been paid) and removal-rather-than-flagging.
  It writes nothing at all.

Each of the first twelve found real bugs the day it was written, and so did
`verify:hot` — two, both of them a list of kinds somebody had written out by
hand — and so did `verify:orphans`, which is the only one so far written to a
bug reported from a screenshot, and so did `verify:store`, which caught ninety
rows on its first run and is the only one that found its bug *before the feature
it guards had ever run*. `verify:motion`, `verify:hand`, `verify:park`,
`verify:doors`, `verify:price`, `verify:routes` and `verify:pens` are the exceptions and say so: each shipped with its feature,
because every claim it makes is invisible in a still frame by construction. None of them is visible in a screenshot of one
seed — which is exactly why they exist.

`verify:ceiling` is the counter-example, and it is the one worth learning from:
the second storey shipped **without** its sweep, on the argument that the sim
half was proven by a smoke test. Four bugs were live in it by the time anybody
played it — a diagonal ride, a lift that would not carry down, a junction
overhead that handed its boxes to the floor, and a duct that only some pieces
were glazed for — and every one of them had to be found from a chair. Three of
the four are assertions this file's own rules would have demanded on the day.
The sweep ships **with** the feature; a smoke test is not one.

⚠️ **`simulate` also inherits who works for you.** `Game.create` reads the saved
world, so the roster and `ownedUpgrades` come along into the throwaway run. Hire
someone between two runs and the second one is measuring a different shop. Every
result now reports `startedWith` — check it matches before believing a delta.

⚠️ **`simulate` reads the live modifier table.** Two runs of the same seed are
only comparable if the world events are the same in both. A stack of duplicate
modifiers was worth 1.9× profit on one measured seed, which will swamp whatever
you were actually trying to measure. `clear_modifiers` before a before/after.

⚠️ **…and `simulate` inherits the world's DIFFICULTY, which is the biggest one
in this list.** A world made before `shared/difficulty.js` existed reads as
`relaxed` — the constants the game shipped with — and one made since is `normal`
by default, which is a materially harder game: 25.1k against 16.3k mean profit
over three seeds of one real save. So every balance figure ever recorded in this
repo is a `relaxed` figure, and a new throwaway world is not a valid control for
one of them. `startedWith.difficulty` is in every result — check it, the way you
check `startedWith` at all.

---

## Who owns what

Keep to your side and you'll almost never touch the same file.

| Area | Path | Notes |
|---|---|---|
| Content (items, crops, customers, events, upgrades, recipes, **fixture art + tiers**, **kits**) | *the database* | Either person, any time, via MCP. No conflicts possible. |
| Look of things (colours, props, characters) | `client/render/palette.js`, `client/render/props.js` | Safe, self-contained, very visible. Good place for a kid to start. |
| UI and HUD | `client/ui.js`, `client/index.html` | |
| What a palette button shows | `client/thumb.js` | Draws a fixture, a floor or a wall from its own art, as inline SVG. Reads `palette.js` — never its own colours. |
| The tutorial | `client/tutor.js` | Client-only, localStorage-only, one file. A step is a predicate over the snapshot — never a press it intercepted. See docs/tutorial.md. |
| How the shop is doing | `client/report.js` | The one menu that is a picture rather than a list. Pure snapshot → HTML, like `hud-meters.js`. |
| One item's own menu | `client/item-menu.js` | Price, standing order, may-the-crew-order. Opened by a supplier row, the way `worker-menu.js` is opened by a roster tile. |
| Rendering internals | `client/render/scene.js` | |
| Economy and balance | `server/sim/economy.js` | Re-run `simulate` after every change. |
| Customer behaviour, crops, actions | `server/sim/index.js` | The biggest file. Coordinate before restructuring. |
| Layout generation | `server/layout.js` | Re-run `npm run verify` after every change. |
| Build placement rules | `shared/build.js` | Imported by **both** client and server on purpose — see below. Also owns `size` — how many cells a kind takes, which is on the KIND because `canPlace` is pure and has never seen the catalog (see docs/pens.md). Also owns `GROUND` — the brush that paints floor, the road, the pavement and the land (a look), and the bay, the drop-off, the break area, the car park and the paddock (a job). None of the nine is a fixture. |
| Tile vocabulary | `shared/tiles.js` | The one place tile kinds are defined. |
| Tag vocabulary | `shared/tags.js` | Adding a tag is safe. Changing what one *means* affects everything. |
| Validation rules | `shared/schemas.js` | Loosen carefully — this is what stops bad content reaching the game. |
| World events | `server/director.js` | No model in it. `inventEvent` is the director. |
| Milestones | `server/sim/goals.js` | The ladder and what each rung pays. A rung is a *measurement* of state the shop already keeps, so adding one is one row and no migration — see docs/progress.md. Six of them add to `catchment` and three pay cash, so re-run `simulate` if you retune them, and call `silenceMilestones` in any sweep that asserts what the money did. |
| Control API / MCP surface | `server/api.js`, `mcp/server.js` | Change both together. |

---

## Commands

```bash
npm run dev       # game server + client with hot reload (localhost:5173)
npm run dev:web   # the browser build: no server at all, the shop runs in a Worker
npm run build:web # a static dist-web/ that needs no server — see docs/browser.md
npm run preview:web   # build it and serve it on :5175 (tunnel-friendly)

npm run deploy        # build the web game and push it live (Cloudflare Pages)
npm run deploy:broker # push the co-op signalling Worker
npm run deploy:all    # both, broker first
npm run tunnel    # build + serve + public Cloudflare URL, for playing together
npm run mcp       # the MCP server (usually launched by Claude Code, not by hand)

npm run deploy       # build:web + upload to Cloudflare Pages (sprocket-and-stock)
npm run deploy:broker# the signalling Worker in broker/ — no game state, ever
npm run deploy:all   # broker FIRST, then the pages: the client bakes in the
                     # broker URL, and a page pointed at a broker that isn't
                     # there falls back to the long-code flow silently

npm run seed      # load data/seed/*.json into the database
npm run export    # dump the live database back to data/seed/*.json — do this before committing
npm run reset     # wipe the world and reseed (loses un-exported content)
```

**Commit ritual:** `npm run export && git add data/seed && git commit`.
Without the export, content you added live exists only in your local database
and the other person will never see it.

---

## Architecture

```
shared/     tags.js       the tag vocabulary + what tags DO
            schemas.js    zod validation — the only gate into the database
            build.js      BUILD_KINDS + where a thing may go (client and server)
            pieces.js     which catalog row a placed thing is, and its ledger name
            jobs.js       how much of a hire's day there is to hand out, and what
                          a rung adds to it (client and server, same reason)
            emotes.js     the four things a body can say with its arms, and who
                          answers a wave. One table, three readers — the server
                          refuses a kind it does not know, the strip draws a
                          button a row, the renderer switches on the same ids
            reputation.js the seven things that move the shop's reputation, and
                          the words for them — the sim writes the keys, the Shop
                          report draws them, `simulate` names the worst one
            reveal.js     when a build button turns up. A gate table read by the
                          palette and by NOTHING on the server — it hides a tile
                          you could always afford, so it is a reveal rather than
                          an unlock, and the shop's rules never ask
server/     db.js         SQLite, content tables, content_version trigger
            content.js    in-memory registry; reloads when content_version bumps
            layout.js     procedural store + farm, sized to what you own
            sim/          the simulation (economy, pathing, customers, crops)
            sim/simulate  headless balance runner used by the `simulate` tool
            director.js   world events (async, never blocks the sim). No model in
                          it — see its header and docs/steam.md §4
            api.js        HTTP control API — everything MCP can do
            rooms/        Colyseus room; broadcasts plain JSON at 10Hz
client/     render/       three.js isometric renderer
            render/lights.js  honours `emits`, and caps how many lamps are real
            render/motion.js  the two loops a stage arc cannot say: `drift` and
                              `motion`. Shared by a break and a running appliance
            render/face.js    the blink, and the brows and mouth that say how a
                              shopper is doing. Writes `crowdLocals` — which is
                              per BODY rather than cached per look, and that is
                              the whole reason one shopper can scowl
            render/emote.js   four arm poses over the rig every body already has.
                              Writes only what nothing else writes — `rotation.z`
                              on the shoulders — and blends into the walk's own
                              `x`, so a wave lays over a walk instead of stopping
                              it. A body with no arm rig (an authored hire) gets
                              the dip instead
mcp/        server.js     MCP tools, a thin wrapper over server/api.js
```

**State is plain JSON, not `@colyseus/schema`.** At this scale the bandwidth
difference is irrelevant and the readability win is large — you can
`console.log(__sns.state)` in the browser and see the entire world.

**Design docs live in `docs/`.** Read the relevant one before restructuring
anything it covers — each records why the current shape is the way it is, and
what the next step was meant to be.

| Doc | Covers | Status |
|---|---|---|
| [docs/building.md](docs/building.md) | walls on tile edges, enclosure instead of a store rect, the kinds-vs-pieces catalog that makes lights and decorations authorable, prices that live on the catalog, and the ground brush that paints floor, the two yard pads, the break area and the ground outside alike, who a way through is for — staff only, entrance only, exit only — the ground pattern that has height, the modifier that demolishes whatever is under the pointer, the curtain that lets a conveyor through and a shopper not, the roller door that is a way through whose whole feature is the picture, taking a build press back, one meaning each for the two modifiers, and the four things an editor is expected to have — the pipette, the row, the stamp and the overlay key that is the shelf's own hover card said about the whole shop, the archway that is a way through with nothing in it, the fence that stopped being the only thing a boundary could be made of, and the head line — how tall a way through is, which stopped being a fact about the wall the day the walls grew, and which is what lets a doorway and a high window line up and be glazed as one piece, and the look that goes UNDER the job — because `GROUND` has partitioned into a look and a job since the yard stopped being furniture, and for as long as one overlay held one answer per cell those two were rivals, so a floor dragged across your own stockroom took the storage away, and moving a whole SELECTION — the one bulk verb that is not carried, because hands hold one fixture, and the one that moves a tile, which is the one thing a held re-flow was never safe for | steps 1–9, 11, 13–27, 29–31 built; 10 cancelled; 12 next; 28 (turning a stamp) proposed |
| [docs/workers.md](docs/workers.md) | workers as authored content, the roster, tier ladders, breaks, the props that make them visible, the break area they are taken in, the shop hand who takes goods back *off* a shelf, the three farm directives that became one, the rung that packs one full crate out of a bay of part ones, the rung that rearranges the shop around where customers actually walk, and the rung that plans its round, and the runner who works the stockrooms so one dock is not a walk every hire in a big shop has to make, and the crew who stood up — five identical parts of a thirty-six part cap at three-quarters of a shopper's height, against a limb that is one flag on a part and a rig everything downstream was already guarded for | steps 1–6, 8–16 built; 7 proposed |
| [docs/belts.md](docs/belts.md) | the trip nobody walks — a conveyor that is GROUND rather than furniture, why it carries crates instead of loose units and therefore invents no seventh place for goods to live, corners that fall out of a facing, backpressure as the whole texture, the arm that is a pair of hands rather than a hire, who is allowed to put something on one — your hands, and a crew who post a box onto a run instead of walking it — and the junction that sorts by where the goods can GO rather than by a filter that falls behind your catalogue, and the same T read the other way — who goes first where two runs MEET, which is a fact about the cell rather than about the belt, so it is asked of whatever piece is standing where the lines arrive, and the piece that usually is is the sorter, and the transport LINE that replaced the tile as the unit, the loader that fills a hopper and lifts a tray so one machine feeds the next, and the farm the run finally reaches — a loader that COLLECTS a pen and a bed, which is the only thing on a run it takes goods out of rather than putting them in, the tunnel whose span belongs to nobody, and the CEILING, where a storey is a field on the placement rather than four more kinds and the lift is the one cell that spans both, and UP as a way out rather than a fixture — so an aisle can keep its endcap and still have a return leg, the tunnel that stopped being its own ecosystem — a span that DIPS to a storey below, so a mouth is a lift pointed down and the piston is the crate's own `deck` rather than two clocks beside it, plus the toggle that brings a span up onto the ceiling instead of the floor, and **Where a crate goes, in order** — the whole routing ladder in one place, with the audit's gap list at the foot, and the map that takes a SUBJECT — pick a shelf and everything but the shortest ways a box reaches it goes grey, because the reachable set is 15 runs of 23 whatever you pick, and the packer that stands still — a crate parked on a run that fills itself from the boxes going past, so a dock of part-crates is one trip instead of three | steps 1–4, 2b, 3b, 4b, 7–12 built; 5–6 proposed |
| [docs/lanes.md](docs/lanes.md) | who may walk on a SQUARE, as opposed to who may cross a line — staff-only ground, the shop floor as somewhere your crew would rather not be, stocking a unit from the back, and one-way aisles | all proposed |
| [docs/customers.md](docs/customers.md) | patience as a budget every annoyance draws on, anger you can see, theft, a shop that turns people away when it's full, the list they came in with, the regulars who come back — a name with a memory, kept on the save rather than in the content database — and the event that moves the CROWD rather than the shelves, matched on an archetype's tags because naming one by id is `if (item.id === 'tomato')` wearing a customer | steps 1–4 and 6–9 built; 5 and 10–12 proposed |
| [docs/ordering.md](docs/ordering.md) | what the shop buys without asking — counting crates and the farm before spending, the shop-wide switches, the per-item standing order, a supplier tabbed by what to do rather than by where a thing lives, the shelf menu that says what is on the van, orders more of a board, counts what the shop already has and shortlists what to keep it for, the item's own menu — where the standing order went to get a thumb-sized control, and where what you charge stopped being a fact about each board, the order you can place twice, at whatever size you meant, and the refusal only the player could read — a van too big for the bay was turned down rather than trimmed, so the biggest units in the shop were the ones certain never to be stocked | steps 1–11 built |
| [docs/deliveries.md](docs/deliveries.md) | why an order should be a promise rather than a teleport — runs and cutoffs, the van as authored content, the lane it drives down, and the car park that is the same idea pointed at customers, the lane a shopper's car drives in and out on, and the road and pavement brushes that decide which way in that is on wheels and on foot | steps 1–7 built |
| [docs/kitchen.md](docs/kitchen.md) | why a machine knows several recipes and runs one, and the rung that buys a second *slot* rather than more speed — one hopper feeding two heads, a tray per slot, the picker turning into a capped list of ticks, and the two clocks a twin machine has that one resolver cannot answer | step 1 built (no rung authored yet); 2–4 proposed |
| [docs/appliances.md](docs/appliances.md) | what a row of machines has to share to look like a kitchen — three generations of art in one catalog, the counter line the shop already had at 0.745 that no appliance stands on, why every shelf in the game is taller than every appliance, shared *lines* rather than a shared chassis, three height classes against one locked footprint, where goods go in and come out on a cabinet with no worktop, and the accent colour that says what a machine does | all proposed |
| [docs/pens.md](docs/pens.md) | the animal that is a building — why a cow you re-sow every time you milk her is a bed's rhythm borrowed by something that is not planted, one `pen` kind against seven authored pieces, a ladder where `speed_mult` is how often you must come and `capacity_mult` is how long you may leave it, the full pen that STOPS rather than banking batches overnight, and the first fixture in the game to take more than one tile — plus the eight places "a fixture is a tile" was load-bearing; and the paddock you PAINT rather than fence, where a head is a divisor on the one clock, the paddock that SUPPLIES animals against the rung that is their CEILING, the animal that came out of the art and onto the grass, and the third population that is neither a player nor a customer | steps 1–2 built |
| [docs/vats.md](docs/vats.md) | the farm that came indoors — a reskin argued as a design, because a pen read with the word "animal" struck out is already a bioreactor: a machine that fills on a clock, stalls when full, and scales with painted floor divided between the machines sharing it. Two `where` flags (`'any'` and never `'indoor'`, or the first wall anybody draws sheds and refunds every farm in every live save), seven pens collapsing to three vats because one piece and one output for ever is right about a cow and wrong about a fermenter, meat moving off `pen` onto `station` + recipes so the sorter finally has something to sort, the paddock that is not pasture but the floor-space dial, and the two kinds of season — the item's tag that moves demand and price and STAYS, against the crop's field that decides whether it grows at all and goes, which is the one claim in the document `simulate` can actually see | proposed; steps 1–7 unbuilt |
| [docs/production.md](docs/production.md) | everything on the shelf came from something — why a recipe book whose outputs nothing eats is a factory with no factory in it, the three tiers and the line between what you buy and what you make, an ingredient as an item with property tags only (so nobody ever buys it and it costs no code), the crafting margin that stops depth being a tax, the six primary-processing machines the shop never had, and the van that stopped selling you 68 of 103 items the day you could make them — and sells them again, because making is cheaper on 67 of the 68 and the arithmetic was defending the appliances all along, so what is left is a crew who leave a recipe output to the kitchen and a player who may order anything | built; the van fork is closed |
| [docs/kits.md](docs/kits.md) | what a shopper is carrying their shopping *in* — a content table of things somebody has on them, the moment/tags pair that assigns one, why the draw is a hash rather than an rng, and the basket you walk over and fetch | step 1 built; 2–4 proposed |
| [docs/progress.md](docs/progress.md) | the milestone ladder — twelve rungs that are *measurements* rather than quests, the three rewards a rung may pay (money, a free run of stock on the next van, and the town growing), the card that stops the world to say so, and the build palette that unfolds with the ladder — a REVEAL rather than an unlock, which is the only reason it may exist beside a rule that says a reward may not be a thing you unlock | steps 1–4 built |
| [docs/difficulty.md](docs/difficulty.md) | why a neglected shop finds a level instead of going under — the settle spring, the floor under demand, and a game where standing still is free; difficulty as a second axis beside the starting tier, upkeep as the first fixed cost, why today's constants are the *easy* preset rather than the default, and the grace a new shop's first week gets because the presets were only ever measured on a day-60 save | steps 1 and 1b built; 2–4 proposed |
| [docs/roof.md](docs/roof.md) | the ceiling you can only see from under it — why the roof already exists twice (`openness` dims every indoor cell to `ROOF_LEVEL`, and `WAYS` authors `roofs` per opening) and has never had a mesh, the one rule every game with this problem shares, the indoor mask as the ceiling, and the clerestory that falls out of hanging it high enough to clear the overhead ducts — where the solid wall stops exactly at the overhead deck and the glass is the clearance the lift baskets needed | steps 1–2 built; 3–4 proposed, and step 2's light half open |
| [docs/ui-shell.md](docs/ui-shell.md) | the HUD, the rail, panels | — |
| [docs/tutorial.md](docs/tutorial.md) | the robot who shows you round a shop you have just made — a veil that blocks rather than only darkens, a step that is a predicate over the snapshot rather than a press it caught, the third answer to "where is the hole" that stops it ever wedging, and the second list for somebody who JOINED a shop rather than making one | steps 1 and 1b built; 2–4 proposed |
| [docs/audio.md](docs/audio.md) | a bus per slider, why the sounds cannot come from the log, the four caps that stop a busy shop being a slot machine, sound as a column on a catalog row, the Sound rows and the Credits tab in the Menu, the loop a fixture holds open while it works — and why the ambient bed was built, played and cut | steps 2–5 built; 1 cut; 6 proposed |
| [docs/waste.md](docs/waste.md) | the shop's way out — the skip, why a hire may carry out rot and never your stock, rot becoming a box on the floor only if you own one, and the one spelling that keeps rubbish from reading as supply | step 1 built; 2–3 proposed |
| [docs/pickups.md](docs/pickups.md) | the customer who never comes in — a collection point as a till whose queue is fed by the road, why picking is `serve` rather than a new job, why a staged tote is not stock, and the share that is a consequence of owning one | all proposed |
| [docs/seating.md](docs/seating.md) | the customer who stops — the break area pointed at shoppers, why the cell is the seat and the bench is a multiplier on it, the first honest dwell impulse has ever had, and the four readers that must NOT share a predicate | all proposed |
| [docs/analytics.md](docs/analytics.md) | is anybody playing this — why GA4 rather than the three other freebies, why a build with no `VITE_SNS_GA` ships none of it, the minute heartbeat that stops a quiet session being cut into pieces, why `mode` is the only place co-op is visible, and the third of the players ad blockers hide, and consent as three states where "has not said" is not "said no" | built, off until the id is set |
| [docs/browser.md](docs/browser.md) | the whole game on a URL — the server moving into the tab, the two seams (transport, store) that keep one codebase serving two targets, why the browser build has no SQLite in it, P2P over a data channel and the signalling that is not free, a host tab throttled to 1Hz, and the MCP surface that is the price | steps 1–7 built; 8 open on numbers nobody has yet |
| [docs/shipping.md](docs/shipping.md) | the standalone binary, inviting one friend in, the session token that is also the invite code, MCP as the shipped mod surface, and what a disconnect does to whatever you were holding | steps 2–4 built; 1, 5–8 proposed |
| [docs/steam.md](docs/steam.md) | selling it on Steam for Windows and macOS — the shell that keeps the renderer we have tested on, a server nobody can find, why Steam Cloud and SQLite's WAL disagree, the 43 milestones that are already an achievement list, why the model call leaves the build and `inventEvent` *is* the director, and why Steam's own relay retires the invite code | step 7 built (the model path, cut everywhere rather than only in the package); the rest proposed |
| [docs/fixtures.md](docs/fixtures.md) | every piece in the build catalog — kind rules, price, tier ladder, how many boards of goods it really draws, and any tier that takes money and moves no number | **generated**, `npm run docs:fixtures` |

---

## Gotchas worth knowing (each cost real debugging time)

- **Colyseus caps *inbound* websocket messages at 4KB.** Server→client is
  unlimited, client→server is not. This is why screenshots are POSTed to
  `/api/screenshot/upload` instead of sent over the socket — a PNG is ~150KB
  and silently closes the connection.
- **`simulate` must stay on an ephemeral game.** `Game.create({ephemeral:true})`
  disables `persist()`. Without it, a balance run overwrites the live save.
- **The layout must place exactly what it's asked for.** An off-by-one in the
  shelf loop meant buying a shelf upgrade sometimes gave you nothing. If you
  touch `layout.js`, verify requested vs placed counts across a range.
- **The director must never be awaited by the tick loop.** It's fire-and-forget
  and still `async`, and both of those are contracts rather than leftovers now
  that the model call is gone: `pushState` does not await it, so a rejection
  would be an unhandled one. **There is no model in the game** — `inventEvent`
  *is* the director, `@anthropic-ai/sdk` is not a dependency, and nothing a
  player reads is generated at runtime. The argument is docs/steam.md §4, and the
  trap it names is the naming: call the local one "the fallback" and somebody
  reads the shipped game as the degraded version of itself. Agents still author
  events — `create_event` and `add_modifier` over MCP — which is where a model
  belongs here: at the keyboard, not in the build.
- **An empty shelf can be relabelled.** `stockShelf` only rejects a mismatched
  item when `qty > 0` — otherwise farm produce has nowhere to go once every
  shelf has been claimed by a delivery.
- **A pallet is the only "goods on the floor" object there is.** Deliveries,
  clearing your hands at the bay, an armful put down where you stand, a stripped
  shelf, an emptied hopper — all of it becomes a pallet. That's deliberate: one
  entity means one renderer, one pickup path, and the stocker tidying every case
  of it for free. Never invent a second container; call `dropGoods`.
- **…and a crate in a PILE is a box, not a container.** Alone it is both: tap for
  one unit, hold for the whole thing, right-click to put one back. Stacked
  (`crateStacked`), the only thing on offer is the whole box — a buried crate is a
  band of about a dozen pixels, so a rummage up there was always somebody else's
  tin, and standing at a tower of boxes the tap took one. *Which* box is still
  chosen by pointing: `pickPallet` picks them apart by height, the ring marks the
  one the ray met, and `liftCrate` no longer refuses a buried one — the boxes
  above settle a step, and the crate you aimed at was the only crate you meant.
  The pile menu that used to name them for you is deleted; a list was answering
  the question the pointer had already answered. Staff still take the top one
  only, and that is the one place `crateOnTop` survives: a job loop has no aim.
- **…and a box on the floor is a SQUARE once there is one on your shoulder.**
  Everything a crate offers the pointer is about single units — a tap takes one
  out, a right-tap puts one in — and with a box already up there none of them can
  happen: `tapCrate` opens with "put the crate down first" and the hold arms
  nothing (`ring: false`). So the cell a box most wanted to go on was the one
  cell in reach you could not name, and putting two boxes together meant finding
  bare ground and carrying the other one over. The *shop* was willing the whole
  time — `dropGoods` tops up a crate of the same thing on the named cell, spends
  a free board in it, and stacks a new box on that cell when it cannot — so this
  was only ever the aim. `haulSquare` (client/main.js) is it, and three things
  fall out. A **pile is fine here**, unlike everywhere else a crate is pointed
  at: `stacked` exists to stop "which of these did you mean", and setting a box
  down is not a question about any of the ones already there. It has to be the
  crate's **own cell** and never `pickTile`'s, because a box is drawn most of a
  tile up-screen of the ground it stands on — the same reason `pickFixture`
  exists — so the tile under the pointer is the one behind it. And the **ring
  round the crate stands down** while the green square is lit, or the highlight
  is advertising a press that names a cell. Hands are deliberately untouched: an
  armful pointed at a lone crate still puts one unit in, which is a gesture that
  works and one a shoulder has no version of.
- **…which is why the drop-off stopped being the only place hands could be
  emptied.** `stow` was the whole way to let go of an armful and it insisted on
  the pad, so picking anything up was a commitment: your hands stayed full until
  you had walked them across the shop, and carrying stock anywhere else was a
  round trip you could not abandon. Nothing about six loaves needs painted
  ground — `dropGoods` puts a crate on any tile, which a stripped shelf has
  always done — so `dropCarry` is the armful's `dropCrate`, armed by the same
  `'ground'` errand a hauled crate uses. The pad still wins when you name a tile
  *on* it, and that ordering is the one non-obvious bit: `stow` hands `dropGoods`
  the pad as a REGION, so crates fill the cells you painted, where a tile drop
  knows only its own tile. Its own verb rather than a branch in `dropCrate`, for
  the reason `haul` is its own field — a shared function is one caller reading
  the wrong one of two hands, which is a conservation hole rather than a visible
  bug.
- **…and a square beside you is two sentences: the GESTURE picks which.** "Over
  there" and "down there" are both true of it while your hands are full, and each
  way of deciding by *distance* breaks the other. Routing first cost the aim — a
  walk ends on the tile you named, so the crate went down under your feet however
  carefully you pointed at the square next to you. Refusing to route inside
  `UNLOAD_REACH` fixed that and cost you the step: no nearby tile was somewhere to
  stand any more, so you could not move one square holding a box. So `walkTo` is
  untouched (a tap goes) and `placeAt` is its own verb (a hold does): it names a
  square without going to it, refuses out of reach rather than widening, and turns
  you to face it. The press arms it so the ring winds where you point; an early
  release is an ordinary tap and you walk. The choice would be invisible, so
  `canDropAt`/`setFloorGhost` paint the square green or red — through
  `isWalkableTile` and `edgeBetween` rather than a second opinion, since a ghost
  the server refuses is the green-ghost bug. A cell that already holds a crate is
  green on purpose: `dropGoods` tops up or stacks, and a pile can be peeled.
  "`walkTo` untouched" is now literally true and was not for four steps: it went
  on arming a setdown on whatever tile it walked you to, so with anything in your
  hands the guess "over there means put it down over there" was live from the
  moment you picked something up. An errand outranks proximity by design, so that
  guess suppressed every job that fires on its own — what it read as is a till you
  cannot serve while carrying a crate, and a ripe bed you walk onto with a box on
  your shoulder doing nothing. The drop-off is the one tile that keeps its second
  meaning, because painted ground has no id and the tap is the only way to name
  it. `verify:build` 7c pins both halves together: a tap arming nothing is only
  safe while the square still has its hold.
- **…and `haul` is where goods can be that is not `carry`.** You can pick the
  whole crate up now, which is `p.haul` — a second place stock lives, beside
  hands. Three things about it are worth knowing before touching either.
  It only means anything because **`crateCapacity` stopped being
  `carryCapacity`**. It was the same number on purpose ("a crate is a trip"),
  and that made hauling move exactly what your arms move — a decision with
  nothing on either side of it. A crate is `CRATE_UNITS` and hands are six, so
  hauling buys capacity with your hands and emptying a crate by hand is two
  trips. It also doubles what a pad holds, because `bayRoom`/`padRoom` are cells
  × this: **+6.5% mean profit over ten seeds**, mostly from orders that stopped
  being refused.
  It is a **separate field rather than a flag on `carry`**, and that is what
  keeps it cheap: every existing reader — stocking, hoppers, the chevrons,
  `homeSupply` — goes on asking about hands and never has to learn that one of
  them is a box. The cost is that everything which *accounts* for hands had to
  learn about shoulders, and each of those is a silent conservation hole:
  `removePlayer`, firing, `saveState`/`restoreStaff`, `homeSupply`. A reload
  that binned a crate would show up as a shop that is quietly poorer with
  nothing to connect it to.
  And the **staff guard is not a filter**. A haul is not a `carry`, so every job
  that tests `!s.carry` — `till`, `sow`, `harvest` — would happily send somebody
  to turn a bed over holding a box. `stepStaff` calls `unload` directly while
  `s.haul` is set rather than filtering the draw, because a hire whose kind
  loses `unload` mid-shift would otherwise have no job left that could relieve
  them. Hauling only ever runs **out of the yard** (`onAPad`), which is what
  makes it terminate: without that, two shelves pass one crate back and forth
  for ever.
- **The BUTTON says which way the goods go: left takes, right puts.** It was
  your hands that said it — a shelf with an armful was somewhere to put things,
  a shelf with empty hands was somewhere to take them from — and that guess is
  what made one button work at all. What it cost is the gesture underneath:
  `boardTakes` excluded full hands, so the unit won the whole tap and a board
  you wanted one loaf off was unreachable with anything in your arms. You could
  not walk round plucking one of each, which is what a shopkeeper does. So the
  direction is *said*, which is the sentence `tapCrate` has carried since a
  crate became rummageable, now true everywhere: **a tap is one unit, a hold is
  the lot**, on either button. Three things this rests on. The right press has
  to arm on the way DOWN (`armPut`) — the ring winds off `p.errand`, so naming
  it on release is a hold that does nothing however long you hold it. It has to
  `release()` the moment the view TURNS, because the right drag is also the
  camera and the player does not move while it spins — `moving`, the server's
  own answer to a walk-past, never fires, so a ring left winding through a turn
  empties your hands onto whatever you were last pointing at. And a right
  release that lasted past `LONG_PRESS_MS` is not also a tap, or pouring an
  armful ends by putting one more unit down. `syncStockAim` is gone with it: the
  pointer owned the put-aim only because the hold had to mean either direction.
- **…and out of reach, the hold buys the WALK.** The third of those three is
  what hid this: a unit across the shop has nothing to wind a ring on, so
  `armPut` answered `walk` with `ring: false` and left the journey to the tap —
  and a hold's release is not a tap, so holding the button at a far shelf was
  swallowed and did nothing at all. Same button, same box, same shelf, and the
  only difference is that you were four tiles further away, which reads as the
  shop refusing you. `spin.trek` is the walk, and three things decide its shape.
  It fires on a **timer** at `LONG_PRESS_MS` rather than on the way down like
  every other arming in there, because the right button is also the camera — a
  walk sent on `pointerdown` sends you across the shop every time you grab the
  view, so `cancelTrek` is on the turn as well as on the release, beside the
  `release()` that is there for the same reason. It names the **fixture** and not
  a tile, so the route ends at a side you can work it from. And **the button
  stays down for the whole journey**, which is the entire trick: `stepActions`
  winds a ring only while something is pressed, so arriving with your finger
  still on it is arriving armed. Let go on the way and you have simply walked
  over, with the put still armed — which is the tap's outcome exactly. The other
  half is that `walkToFixture` now **carries `put`**: a walk is one sentence with
  a walk in the middle of it, and a direction dropped at the kerb means the
  errand that fires on arrival is a *left* button's errand. A shelf never
  noticed, because it offers the same job either way round; an appliance has two
  openings, so what you got was a machine you walked a crate to and then
  collected the tray from.
- **You name it, and the ring fires it.** Anything that moves goods into or out
  of your hands is pointed at first: a tap on a fixture is a *walk plus a name*
  (`walkToFixture` sets `p.errand`), a tap on the drop-off is the same thing on
  ground that has no id (`walkTo` reads the pad), and `errandAction` arms the
  ordinary charge when you arrive. `actionAt` answers "what would *this* do";
  the ring still decides *when* — a second, the target lit, and leaving throws
  the charge away, so you say no by walking off. The snapshot carries the armed
  action from the tick it arms, at zero progress, so the client can light the
  target up and name what is about to happen.
  Proximity is left with the two jobs that touch no goods — a till with somebody
  waiting, and turning a rough bed over — plus the one that does: the ripe bed
  **under your own feet**. Money is not even in that list — it is
  scooped up by walking over it (`stepCashPickup`), which is the one thing
  nobody has ever wanted to decline.
- **…and the bed is the one goods job that came back, on a tile rather than on a
  radius.** Both reasons it left are paid off, and either one going away again
  puts it back. "Which one did you mean" is what killed proximity everywhere
  else, and a plot has an answer no aisle has: a bed IS the ground, so the tile
  under your feet names exactly one — `Math.round(p.x) === plot.x`, deliberately
  not `near()`, which reaches the neighbouring bed and would strip a field. And
  "picking fills your hands, and full hands refuse you everything else" stopped
  being true when `harvest` started crating the surplus. It is also the one
  action that charges with **no button down** (`auto` on the candidate, read in
  `stepActions`): a field is six beds, and the press was six presses to do the
  one thing a farm is for. The other two consents are untouched — `moving` still
  throws the charge away, so walking a row strips nothing, and the ring still
  winds in full view. The trap is that there are TWO ways to the same bed and
  `auto` has to be decided in both: proximity finds the bed under your feet, but
  `errandAction` outranks proximity by design, so a bed you *tapped* comes back
  through `actionAt` — and walking to a bed is the ordinary way to end up
  standing on one, which made the self-firing path the one nobody takes. It
  shipped that way for exactly one round of play-testing. `verify:build` pins
  all four, including the walk-over and the tap.
- **…and a harvest that does not fit goes in a crate, because it used to go
  NOWHERE.** Hands hold six and a bed gives two to seven, so the second bed of a
  row was clipped to whatever room was left and the rest silently ceased to
  exist — nothing logged, nothing on the floor, a bed drawing four plants
  handing over one. That is the only place in the game goods were destroyed
  (`dropGoods` is the answer everywhere else), and what it read as was a farm you
  could only work one bed per trip. The surplus lands on the tile under YOU
  rather than on the bed — a box parked on the seedlings you just put back reads
  as the harvest having failed — and `dropGoods` merges within a couple of tiles,
  so a block of six beds leaves one readable pile. Two things follow: `harvest`
  now has no refusal at all, and a crate on the farm is supply the shop counts
  (`homeSupply`), which a stocker collects because `unload` scores a stray above
  a bay crate.
- **…and it was the other way round for four steps, which is worth knowing
  before you put anything back on proximity.** The ring made proximity *safe*
  and never made it *precise*, and that distinction is the whole history here.
  Pickups came out first: proximity can only offer the nearest pallet, which at
  a bay stacked three deep is nobody's choice. Putting down is the same bug with
  worse consequences, because your hands are already full when it fires — an
  aisle is a row of shelves on a three-tile pitch, so stopping anywhere in one
  meant one of them took your armful and which one was a question about your
  feet. Carrying stock across your own shop was not a thing you could do. The
  tell was the patches: `stowLock`, then `tookFrom`, both latches holding off an
  action nobody had asked for. Both are gone, and neither is needed, because an
  errand is spent when it fires and nothing re-arms.
- **…and *standing* is the other half of "standing next to it".** `ACTION_TIME`
  was the whole defence against a walk-past — a second of charge against about
  three quarters of a second to cross a `REACH` — and that only ever described a
  straight line through the middle at full speed. Clip the edge of the circle,
  turn inside it, slow at a corner or walk the length of an aisle, and you are in
  range for as long as you like: crops got picked and crates got lifted by people
  on their way somewhere else, which then fills your hands and refuses you
  everything. `stepActions` drops the charge for anyone `moving` — a route with
  legs left, or a direction held — exactly as if they had left the reach. It
  costs nothing: every route ends stopped at the working spot the tap named. It
  did put a state no player can reach inside the sweeps, though, which is why
  `verify-build`'s `stand` clears the path and the keys along with the position —
  `take` plans a route, and teleporting to its end *is* arriving.
- **There is one errand and it has four kinds of address.** `p.errand` is
  `{ at, itemId }`: a crate by its own id, a fixture by its id, a bare tile as
  `'ground'` plus coordinates — which is where goods in your hands or on your
  shoulder go down — or the literal `'pad'`, which is the drop-off — the only target in the shop that is a
  *region* of painted ground rather than an object, and the reason the errand is
  not simply a fixture id. `take` still exists as its own verb for the one case
  that names something finer than a fixture: a shelf holding three things is
  three piles at one address, and a fixture id cannot say which board you meant.
  Everything else is `walk-to`.
- **…and the pointer can name a board now, which is what a pile of goods being
  drawn as itself was always worth.** For four steps the only thing that could
  say *which* board was the shelf's own menu, so an armful off a shelf cost four
  inputs — open the unit, find the row, walk, press and hold — and three of them
  were ceremony around a decision you had made by looking at the bread. The
  address was the missing half, not the verb: `pickFixtureHit` answered "which
  fixture", and a unit is one target however many piles are standing on it. Each
  welded goods group carries its item id (`syncShelves`), the walk up to the
  pickable group notes it, and `pickAim` hands it back beside the fixture. Three
  things about it are worth knowing before touching either end. The **marker has
  to be round the pile** (`boardBox`, a cage measured off those meshes) — a frame
  on the tile is the same frame for all three piles, and the whole question here
  is which one. The press names it on the way **down**, the way a crate does, or
  a board you are already standing at arms its charge under a button that has
  just come up and the press reads as dead until you press again — which is the
  four-step version wearing one fewer step. And the **unit is still the target
  everywhere its stock is not**: a tap on the frame, the base or an end panel
  opens the menu, which is what keeps pricing and assignment one press away, so
  `boardTakes` is asked identically by hover, press and tap or the highlight
  advertises something the press does differently.
- **Held actions re-arm the instant they finish, and that is now only true of
  the two proximity ones.** It is why the `till` charge is long and why a Clear
  tool that stayed armed once ate seven shelves in a row. The general rule
  survives the change and is worth keeping in mind for anything new: what
  matters is not whether an action is explicit but **the state it leaves you
  in** — the retired `tookFrom` existed because a pickup leaves you holding
  something *stood at the thing it came off*, which was exactly what `stock`
  armed on, so a board emptied by hand refilled itself on the next tick.
- **…and how LONG a hold is has a floor, which is on the client.** `ACTION_TIME`
  came down from a second to half of one, and every goods-handling time with it
  (`stow` 0.45, `crate` 0.65), because neither thing the second was buying is
  still true: the duration was the defence against a walk-past and `moving` is
  now, and these actions are all *named* by pointing first, so the ring is
  confirming a finished sentence rather than guessing at one. What it may not go
  below is `LONG_PRESS_MS` (420ms, `client/main.js`): the press is only ruled a
  hold at that mark, and an action that fired before it would have its release
  read as a tap **as well**, which re-sends the errand it just spent. `till`
  (1.7) and `serve` stay where they are — one is effort you can see, the other is
  a throughput number the checkout ladder divides.
- **…and a shelf board grades two ways: a tap is one unit into your hands, a
  hold is the whole board into a crate.** The crate was always the ending — a
  board holds more than a pair of hands, so "take it all" only means anything if
  what it fills is a box — and it goes **onto the shoulder, not the floor**
  (`p.haul` is the point: walking off with the lot, where a crate at your feet is
  a second gesture to pick up). It is `ACTION_TIME` like every other hold, and
  `crateBoard` moves everything that fits in one call, bounded by the crate's own
  room so a board bigger than a box leaves the rest standing.
  It was **metered** for four steps — one unit per turn of a repeating ring
  across a second (`PULL_SECONDS`, `pullEvery`, `repeat` in `stepActions`), so
  you watched the box fill and letting go at half a second left you with half the
  board. It read beautifully and it is gone, because it was the only gesture in
  the game shaped that way and a single exception is not a rule anybody learns.
  **Two traps died with it, and both are worth knowing before anything else in
  here grows a computed duration.** It was the only action whose time came from
  the *world* rather than from a constant, and `pullEvery` floors at 50ms — so on
  a stocked board the first unit crated itself a twentieth of a second after the
  button went down, which is inside `LONG_PRESS_MS` (420ms), the mark the client
  rules a press a hold at. An ordinary tap therefore came away with a crate
  holding one loaf, *intermittently*, because a nearly-empty board pulls slowly
  enough to be safe. And it was the only job that spanned ticks while your hands
  changed, which is the whole reason `pulling` had to exist: `aimAt` and
  `clearAim` say where a load should GO, which becomes a live question the moment
  the first unit lands, so both had to yield mid-pull. One ring needs none of
  that. The count is still **said once, with the total** (`endPull`) — twelve
  lines of "Took 1x Bread" is one event told twelve times.
- **…and hands and a shoulder stopped refusing each other.** `crateBoard`
  refused with `p.carry` set ("nobody shoulders a box while holding six loaves")
  and `unshelve` refused with `p.haul` set, which is one rule said twice: goods
  may only ever be in one place at a time. That rule predates there being two
  buttons. A left press takes and a right press puts, so the direction is never
  in doubt — and what the pair actually cost is that picking ONE loaf up was what
  stopped you clearing the board it came off, and a box on your shoulder meant no
  shelf in the shop would hand you a single unit of anything. Both stores stay
  separate everywhere else; they simply fill independently. `tapCrate` keeps its
  own `p.haul` refusal, which is a different claim — a box on the floor becomes
  a *square* once there is one on your shoulder (`haulSquare`), so the gesture is
  taken, not the rule.
- **Build mode is the exception: it arms nothing but the till.** `actionFor`
  answers `serveCandidate` and nothing else the moment `p.build.on` is set — the
  one job in the game that is not a question about the pointer. A shopper at the
  counter is one till, one job, no aim and no press, and suspending it means a
  customer stood there while you put a wall up, waiting for you to find the
  button that turns building off. Everything else stays suspended, and the split
  is the test for anything you want to add back: if it needs the pointer or your
  hands, it belongs to the mode. Proximity picked the nearest fixture *centre*, and
  with seventeen shelves on a three-tile pitch that is not a choice anybody can
  make — you got whichever was closest, never the one you meant. So every build
  verb names its target instead: the client aims with `Scene.pickFixture`, and
  `build-lift` / `build-empty` / `build-rotate` / `build-remove` all carry an id.
  Reach is not checked either — you aimed at it, and placing never required you
  to walk over there. Being in build mode is the consent.
- **…and build mode is two things wearing one flag.** It is the *permission* the
  server gates every fixture verb on, and it is the *palette* that makes a tap
  on the floor a purchase. A fixture menu opens with or without the mode, so
  `withBuildMode` switches it on around one press of Empty or Rotate — quietly,
  which by design leaves the bar where it was. What nobody noticed is that the
  ghost read `buildOn` and then fell back to `buildTool`, which has a *default*
  (`'shelf'`) because the palette is where you would normally have changed it.
  So pressing Empty armed a shelf nobody had chosen, out of a mode with nothing
  on screen saying it was on — and the tap that placed it called
  `commitBuildMode`, so the borrowed mode also stopped ever being handed back.
  `ui.paletteArmed` is the honest test now: build mode **and** the bar is up.
  `showBar` already says why (a bar you cannot see is a mode you cannot see you
  are in) — the quiet mode is the one exception to it, so anything that decides
  what pointing at the world *does* has to ask the bar rather than the flag.
  Carrying is asked first and separately: a Move errand borrows the mode the
  same way and must still be able to put the thing down.
- **…and a MODIFIER is the third thing that decides what a press does, which is
  the one that DESTROYS something.** Getting rid of a thing was four rules, each
  true of one tool: the bulldozer took fixtures and walls but only while it was
  armed, shift-right knocked a wall through but only with a wall tool up, the same
  press scraped a cell but only with a brush up, and paint had no eraser at all.
  So the pointer's answer to "get rid of that" depended on a decision you made at
  the far end of the bar. Holding **Ctrl (Cmd)** with the palette up now aims at
  what is ALREADY THERE — `razeAim`, fixture → painted face → wall → painted
  ground, most-specific-first — and the armed tool is not consulted at any rung,
  which is the whole of what makes it one sentence instead of four. It is
  **`paletteArmed` and not `buildOn`**, or a mode a fixture menu borrowed turns
  the key into a bulldozer with nothing on screen to say the mode is on. Both
  refusals live in the **aim** rather than at the press, so nothing lights up red
  that a click would not remove. The key is a **flag** (`razeDown`) because the
  hover needs it — the frame has to appear under a pointer that is not moving —
  and `pointermove` writes it too, since a modifier pressed while another window
  had the keyboard never reaches the key handler. And a press that finds nothing
  is **consumed**, or it is the one Ctrl-click in the mode that builds something.
- **…and it shipped on SHIFT for four steps, which is the part worth
  remembering.** Shift meant two things told apart by whether the palette was up
  — bulldozer with the bar up, multi-select without it — and the cost was named
  at the time and chosen: you could not shift-pick a row of shelves while
  building. It was the wrong trade. The split made the answer to "what does this
  key do" a fact about a strip of UI at the bottom of the screen rather than
  about the key, so the one place you most want to pick several shelves —
  build mode, where you are rearranging the shop — was the one place the key
  that picks them meant delete. The tell was in the argument for it: both
  gestures are made by holding the modifier and clicking repeatedly, which is a
  description of ONE gesture with two outcomes. Two keys, one meaning each, is
  also what every other editor does. Two traps in the move: **Ctrl+click on a
  Mac is the secondary click**, so it arrives as `button === 2` and never
  reaches the bulldozer branch — which is why Cmd is read as well and is the
  key people there already hold; and **Ctrl is asked first** in `pointerdown`,
  so Ctrl+Shift is a demolition rather than an ambiguity.
- **The camera is chained to your body, and build mode is where that is wrong.**
  `camPan` is an offset off the player with a 14-tile leash, which is right
  while you are shopkeeping — a view that can lose you is worse than one that
  cannot see the far shelf, and walking anywhere reclaims it (`recentre`). It
  is exactly wrong while building, because the reason the view needs to move
  there is to reach somewhere you *cannot stand*: a room you have just sealed,
  the far side of the fence, the end of a grown farm. So WASD flies the view
  instead of walking you while a tap would place (`flying()`, the same
  `paletteArmed || holding` test the ghost uses), and `setFreeRoam` swaps the
  leash for the map. Two things this cost, both non-obvious. `clampPan` has to
  be the ONE place either bound is applied — a fly clamped to the world beside
  a drag clamped to the leash fight over the same field and the view snaps back
  the instant you touch the mouse. And taking the wheel has to stop the feet:
  a key held across the moment build mode came up leaves you walking at the
  server for as long as it stays down, because the *release* is what sends a
  zero and the release now goes to the camera. An edge-scroll version of this
  was built first and thrown away — it fires when you did not ask, and the band
  along the bottom is also the path to the toolbar.
- **…and it was chained to the SNAPSHOT rather than to the body, which is why
  walking read as chunky.** Three separate causes landing in one place, and none
  of them is a stutter in the shop — the shop was smooth throughout. **The camera
  chased a staircase.** `syncState` set `camTarget` off `state.players`, which
  arrives at 10Hz, while `ACTOR_CHASE` eases the body somewhere else every frame:
  a lerp toward a target that steps 0.42 of a tile every hundred milliseconds
  does not smooth the step away, it *rings* — the view lurches on the frame a
  packet lands and coasts until the next. That ripple is not on one body, it is
  the entire screen. `trackEye` takes the target off the mesh, after
  `animateActors` and before the pose. **The playing camera had no floor.**
  `EASE`'s own note argues at length that a proportional ease is a spring which
  "never arrives while the thing it chases is still moving", and then gives the
  floor that fixes it to `CINE_EASE` only — so the recording camera got the dolly
  and the person actually walking got the spring, sliding the whole shop under
  their feet and gliding it back on every stop. The number is arithmetic rather
  than taste: a floor is only a floor while it out-paces what it chases, and
  `PLAYER_SPEED * SPRINT_SPEED` is 6.72 tiles a second, so anything under 0.112 a
  frame reverts to the old trailing spring the moment somebody holds Shift —
  which would read as *sprinting* being the broken part. **And the gains were per
  raw frame.** Every other easing in the renderer is against `dt` and each says
  why; the camera pose was the one loop still on a fixed fraction, and it is the
  loop where it matters most, because at 30fps `look` was half as responsive and
  the floor half the speed — so the view trailed twice as far behind a walk on
  exactly the machine already struggling to draw it. Two causes compounding,
  reading as one. `gainFor` is the conversion and it **compounds rather than
  scales** (`1 - (1-g)^(dt*60)`): a lerp is repeated multiplication, so linear
  scaling overshoots past 1 on a slow frame, which is a camera that snaps on
  precisely the frames that hitched.
- **…and a body SNAPPED between headings, which is the half a smooth position
  cannot hide.** `facing` is `atan2` of a direction, and no person in this game
  is ever handed a continuous one: the keys send eight (`Math.sign` in
  `pollInput`), so steering W then D is a 45° jump and reversing is 180°, and
  `followPath` walks tile to tile, so every corner of every route is a quarter
  turn taken between two frames. `syncActors` wrote it straight onto the mesh, so
  what you watched was the model being swapped for a different model rather than
  somebody turning round — and you are watching the one you are steering.
  `ACTOR_TURN` is `VEHICLE_TURN` arriving for people, at 13 against a lorry's 5,
  because a van turning slowly is a van and you turning slowly is a control that
  does not answer. Two things it rests on. It goes the short way (`turnTo`), or a
  reversal unwinds 180° the long way about — a full spin on the spot, at one
  heading only, which is the kind of thing you see once and cannot reproduce. And
  `rec.yaw` had to stay the field it always was while becoming the **drawn**
  answer rather than the shop's: `animateRest` and `animateEmote` both blend off
  it to mean "what they would otherwise be facing", both run per frame, and both
  were being handed a heading that only moved when a packet landed.
- **A thing put down against a wall turns its own back to it — and a wall is not
  a tile.** `faceAlong` in `shared/build.js` is aim assist, not a rule: it picks
  the facing whose browsing spot is open and whose *opposite* side is not, which
  is the one right answer per tile that building a row of shelving otherwise
  makes you type out by hand. Three things hold it together. The edge test is
  the one that is easy to leave out and impossible to notice missing — walls are
  drawn on the line between two tiles, so the far side of your own shop wall is
  ordinary walkable grass and the far side of an annex divider is ordinary shop
  floor; read tiles alone and it works against the generated shell and does
  nothing at all against a wall the player drew. Ties go to the facing it
  already has, which is what stops it spinning as you slide along an aisle.
  And `rotPinned` is the off switch: pressing R has to stop it, or the ghost
  turns straight back on the next frame and R reads as a dead key. Verified in
  `verify:build` as three claims — always usable, backs onto a wall whenever any
  facing could, never spins — over every legal shelf tile × four starting angles.
- **…and assist is for a facing nobody chose, which a fixture you PICKED UP is
  not.** Rot 0 is where the model happens to have been drawn, so on a new unit
  off the palette the best answer for the tile is the right answer. One you are
  carrying already has a facing — the one you set the last time it stood
  somewhere — and re-deriving it from the new tile only *agrees* with keeping it
  when the tile happens to. That is what "moving something reset its rotation"
  was: not a reset anywhere in the code, but a search improving on a decision
  somebody had already made, every frame, invisibly. `faceAlong`'s `keep` is the
  distinction: a carried unit settles for a facing that WORKS rather than
  holding out for the best going, so it only turns when its own angle would
  leave nowhere to browse it from — the one case where keeping it silently costs
  you the shelf. The bar `keep` holds a facing to is the *same predicate* each
  search settles for (`workable`), or a carried till would keep a facing the
  search would have rejected.
- **A model can carry stages, and anything can drive them.** `shared/model.js`.
  A model is either `parts` (always looks the same) or `stages[]`, and whoever
  draws it passes one 0..1 number: a crop passes its growth, a fixture passes
  its tier, a pastime passes how far through the break they are. One authoring
  shape and one resolver, so the next kind of prop gets stages the day it exists
  rather than growing its own art-swapping code. The pastime is the proof: a mug
  that empties and a sandwich eaten down to the crusts cost one nullable column
  and one field in `snapshot()`, and no code in the renderer knows what a mug is.
- **…and a prop can spend that number on the SHOP instead of on itself.** A
  clock that does not tell the time and an OPEN sign hanging over a shut shop
  are the same failure, and neither is a bug you can see — they look exactly
  like a clock and a sign. The cause is that both are props, so their one 0..1
  was spent on a tier ladder they do not have: `tierProgress` of a single rung
  is 0 for ever, and a hanging sign was therefore a *photograph* of a sign.
  `signal` on a piece (`shared/signals.js`, `time` and `open`) replaces that
  number with the world's, and both readers take it from the one field — stages
  swap on it, and a part flagged `motion: sweep` turns *to* it, which is a clock
  hand. Five things about it are worth knowing. It **replaces rather than adds**,
  so it belongs on decorations and nothing else: a shelf with a signal would
  author perfectly and quietly stop showing you which shelf you bought, which is
  the "tier that changes no number" trap pointed the other way. A sweep is a
  **pose and not a loop** — no easing, no accumulation — because the rest of
  `animateMotion` is built for a blade winding up, and a clock eased in from
  twelve is wrong for the first half-second of every session while an
  accumulated one drifts off the time it is telling. A hand needs an authored
  **`pivot`**, which is the one thing here that could not be read off the art:
  a bar offset from a case could be hinged at either end, and turned about its
  own middle it is a compass needle pointing at two times at once. A watcher is
  built wearing **every stage at once** with one visible (`buildWatcher`) rather
  than rebuilt when it swaps, because a signal changes on the shop's clock
  rather than on a purchase — a rebuild would have to re-run the whole tail of
  `addFixtureProps` (the pick box, the bake, the layer, the landing) or quietly
  drop one of them. And a watcher that is also a **lamp** has to take its glow
  with it (`emittersIn` scales by the signal, `aimLights` re-bakes when it steps),
  or the art goes dark while the pool of light on the floor goes on saying open,
  which reads as a rendering fault rather than as a sign that is off. The trap
  for the next one: **writing has a front.** A tube thick enough to stand proud
  of both faces of a board is one word and one MIRROR of it, and the far side of
  the sign says N3PO — so a double-sided sign is the word twice, laid the
  opposite way round, which is what took `MAX_PARTS` to 36.
- **…and one resolver takes ONE number, which is why an appliance has two
  models.** `model`'s 0..1 is already spent on the tier — a Commercial machine
  is stage 2 of its own art — and how far through a batch it is runs 0..1 on a
  clock of its own. Two quantities, so two models: `work` on the piece (or on a
  variant, since a toaster and a blender are two shapes of one appliance) is
  what it looks like *while it is running*, drawn over it in its own model
  space, stages driven by `progress`, and gone the moment the batch ends. Reach
  for a second model when you find yourself wanting a second 0..1 — not for a
  second *look*, which is a variant, and not for a second *number*, which is a
  tier.
- **…and a model authored for a FIXTURE and drawn as a BODY is a quarter turn
  wrong, silently.** Two conventions have always met here and neither is a
  mistake: fixture art is drawn **nose east** — `+x`, length along x, which is
  what `buildFixtureGhost` turns by and what `docs/fixtures.md` renders — and a
  body's `facing` is `Math.atan2(dx, dz)`, so `rotation.y = facing` swings local
  **+z** onto the heading, which is right for a character whose nose is a nub on
  +z. `vehicleYaw` is the one line that reconciles them, and its own note says
  why it deserves a name: a van is nearly symmetric front to back at this zoom,
  so a lorry driving sideways up the border ring still reads as a lorry, and you
  blame the art. A pen's `body` is the second thing to meet this — a `fixtures`
  row that `syncActors` draws — and a hen is *more* symmetric than a van, so it
  reads as a slightly odd chicken rather than as a bug. `Scene.buildAnimal` bakes
  the quarter into a wrapper group rather than setting `rotation.y`, because
  `syncActors` owns that field on whatever it is handed. The general shape:
  **which way is forward is a property of the TABLE a model was authored for,
  not of the model**, so anything that draws one table's art through another
  table's renderer owes a turn.
- **…and anything that walks between two cells walks THROUGH the ones in
  between.** An animal is kept in its paddock by the set of legal cells and by
  nothing else — no pathing, no edge test, no enclosure question — which is
  airtight and was wrong on the first run, because a leg is a straight line: a
  body handed a cell several squares away across an L-shaped field cuts the
  corner, and the corner is not in the field. 122 strays over four hundred
  seconds, and what it draws as is a pig strolling across the shop floor between
  two halves of its own pen — which reads as bad pathing in a feature that has
  no pathing in it. `stepAnimal` steps to the **next cell along**, four-connected
  and never eight, because a diagonal clips the corner of the two cells it
  passes between and either of those may be the car park. Worth asking of
  anything new that moves between named cells: **is every cell on the way also
  named?**
- **A kit is an object; a pastime is an activity.** `kits` is a content table of
  things somebody has on them — a paper bag they walk out with, a basket they
  fill, a trolley, a thief's swag sack. It looks like a pastime and is not one:
  a break has a clock, a spot to stand at and energy it puts back, and the prop
  is a detail of it. A kit has none of those. Authored into `pastimes` it would
  be a row whose `seconds`, `spot`, `restores` and `buys` are all dead, which is
  the "tier that changes no number" trap wearing a bag. Two columns are the
  whole assignment: `use` is the moment (a closed set in `KIT_USES`, because a
  moment is a thing the sim has to know it is in and hand a fullness to), and
  `tags` is *who*, matched against the archetype's — which is why `archetypes`
  grew a `tags` column, since until then a row that wanted to say "the
  tight-fisted ones" had no choice but to name an id. **It replaces the loose
  armful** rather than hanging beside it, and no kit authored is the armful
  exactly as it was, which is what makes the whole table opt-in. The field is
  spelled `use` and means `when` because `upsert` builds its column list
  unquoted out of the object's own keys — a content field named after a SQL
  keyword fails at the first write and nowhere earlier, which is worth knowing
  before naming a column on the next kind.
- **…and which bag somebody carries is a HASH, not a draw.** Every balance
  number in the game is downstream of how many times `this.rng` has been called
  — that is why `Game.namer` is a stream of its own — so drawing a shopper's bag
  out of the measured stream would move every basket, crop and spawn roll after
  it, and two `simulate` runs either side of authoring a *paper bag* would
  diverge with nothing in the output to say why. `hash01(id:use)` costs no draw
  at all, which beats either stream: the same shopper always carries the same
  bag, a reload gives them it back, and the balance is provably untouched
  because nothing random happened. The client already does this for a hire's
  breathing phase. Reach for it for anything cosmetic and per-person.
- **A machine that cannot be seen working is a machine you cannot tell is on.**
  Which is what every appliance was: mid-batch and untouched-since-Tuesday drew
  the same picture, and the only tell was the row of ingredient ghosts over it
  disappearing — an absence, in a shop full of things. Four traps came out of
  fixing it, and three are invisible rather than wrong.
  A part flagged `motion` runs while the thing it belongs to is **working**, and
  a thing with no idea what working means — a fan, a mobile, a sign — always
  runs. That second clause is not a nicety: without it the flag silently does
  nothing on every kind except `station`, which is the "tier that changes no
  number" trap wearing a different hat.
  **A spin has to accumulate.** Read off the clock and eased down, a stopping
  blade drags itself back to where it was drawn — a machine that rewinds. Adding
  up how far it has turned means it stops where it stopped, which is what a
  stopped blade does.
  **Spinning a cylinder is invisible**, exactly as spinning a ring was: it is
  rotationally symmetric, so a perfectly correct animation nobody can see. The
  blender turns a paddle.
  And the moving parts of the machine itself belong to `staticRoot`, which a
  re-flow disposes wholesale — so `movingFixtures` is filled and cleared in the
  one place that builds them (`addFixtureProps`). Whatever it puts on top while
  it runs is a prop in `actorRoot` with the other readouts, positioned and
  *turned* every sync, or the steam comes out of the back of a machine you
  rotated.
- **Kinds are code; pieces are content.** A `fixtures` row is a *piece* — its
  own id, its own model, variants, tier ladder and price — and it names a *kind*
  from the closed `BUILD_KINDS` set in `shared/build.js`. So there can be four
  planters and two shelf designs, but not a new kind: where a thing may go,
  whether it blocks and which side you use it from are behaviour, and a fixture
  nobody can place or reach is scenery. Same shape `JOBS` uses for workers.
  A row written before the split has no `kind` and is read as naming itself
  (`kindOf`, `shared/pieces.js`) — a read-time default rather than a migration,
  so an old database, an old export and a fresh seed all agree with no ceremony.
- **A piece that resolves to its kind looks correct until somebody authors a
  second one.** Every fixture came from a row whose id *is* its kind, so a
  lookup that falls back to the kind is invisible in a shop that owns the
  original five — and then presents as "my new shelf looks like the old one",
  which reads as bad modelling rather than bad wiring. `verify:catalog` gives its
  test shelf a deliberately *shorter* tier ladder so the wrong row is a number
  that differs rather than a picture that happens to match.
- **Enclosure is shop-wide and all-or-nothing, so anything gated on "indoors"
  fails everywhere at once.** Take enough of a wall out and `computeIndoor`
  returns *zero* indoor cells — not a smaller room, none — and every rule
  written as "indoors" then applies to nothing. The queue is where that showed
  up: `growLane` walked `insideStore` tiles only, so no lane grew a single step,
  every lane came out length 1, and `queueSlot`'s clamp put the entire queue on
  the serving tile. What you see is a pile of shoppers standing inside one
  another at the counter, days after the wall came out, and it reads as the
  queue code having broken — a real save had it, and the tell was `laneOf`
  answering 1 while `queueMax` said 0. A lane now takes its indoor requirement
  from **where it starts** (`indoorOnly` in `startLane`): a till in a room
  queues in that room, which is every generated shop and every sweep, and a till
  with no room queues on whatever floor it can reach. The wall between two tiles
  still stops the line either way. The general shape is worth keeping: a rule
  phrased against enclosure has a silent third state — no enclosure — and it is
  not "a bit less room", it is the rule applying nowhere.
- **…and a wall's answer now depends on who is asking, which no rule in this game
  used to.** A way through can be signed — staff only, entrance only, exit only —
  and that is four more entries in `E` rather than a bit beside it, because
  `SOLID.has(edgeBetween(...))` is the inner loop of A\*. Four things about it are
  not obvious. **`shopperCanCross` is a function of the STEP, not of the edge**:
  a one-way door is passable one way and a wall the other, so no set of kinds
  could answer it, which is why `findPath` takes `{ shopper }` and `reachable`
  takes an optional `cross`. **Which way is "in" is READ off the `indoor` mask**
  rather than stored — so a probe built by `withEdge` has to be handed a fresh
  mask or you are asking a shopper question of the shop you had before the wall,
  and a boundary whose two sides agree (an interior door, a gate, *any* opening
  once enclosure is gone) lets everybody through, because refusing there would
  seal every signed door in the world the day a wall came down. **The queue
  refuses every `RULED` opening outright** instead of asking about direction: a
  lane is grown outward from the till and walked toward it, so a one-way test
  would give whichever answer the loop happened to ask for. And **the sealing
  warning had to become a shopper's flood while the fixture-stranding one had to
  stay everybody's** — the first is why you are told that making your entrance
  exit-only shuts the shop, and the second is why a shelf you deliberately put in
  a stockroom does not warn you about itself on every wall you draw afterwards.
  `verify:doors` pins all four. Nothing routes anybody to a *named* door, which is
  the reason this cost so little: A\* finds the way in, so signing the front door
  of a shop with a service entrance is a longer walk rather than a closed shop.
- **…and a doorway is the one thing you can point at that has no tile.** It has no
  id and no record either — it is a number on a lattice line — so it was also the
  only openable thing in the shop that nothing marked, and a menu you cannot tell
  you are pointing at is a menu that does not exist. `pickWay` (client/main.js) is
  the aim, and it is asked by the hover AND by the tap, which is `boardTakes`'s
  rule and matters for the same reason: a bar that lit up while the press opened
  the shelf behind it is the green-ghost bug wearing a marker. Three things about
  it are worth knowing. The precedence is **person, fixture, crate, then the way**
  — things beat gaps — and that is what keeps the shop front usable, because the
  awning stands on the very tile the front door opens onto. **It is build mode
  only** (`paletteArmed`, the test `aimable` uses, so a mode a fixture menu
  borrowed puts nothing on the walls): every row on that menu is a build verb, and
  a doorway is *everywhere* — the shop front is a line of them, so out of the mode
  the amber bar lit along the whole front of the building as the pointer crossed
  it. `toggleBuild` shuts an open one on the way out, beside the fixture menu.
  And **the hold opens
  nothing** (`HOLD_OPENS = false`): the gesture is wired end to end and switched
  off, so a new thing you can point at, added only to `openAtPointer`, ships dead
  — the tell is a highlight that works over a press that does nothing.
- **…and a window's four looks are VARIANTS, on the one axis an edge had left.**
  `GLAZING` is `WAYS`'s sibling and the line between them is the useful part: an
  opening's kinds differ in who may cross, which the sim reads, while a glazing's
  differ only in where the glass starts and stops, which nothing reads but the
  renderer. So the variant rule applies — one price for all four, swapping between
  them free, no `simulate` run over a picture — and a fifth look should be two
  numbers (`sill`, `head`) in `EDGE_BASE.glass` and nothing else. What they share is
  `edgeFamily`, which is what `buildEdge` charges the refit against and what the
  edge menu lists: within a family you keep the door, or you keep the wall. Two
  traps in the geometry, both invisible in the file you would edit. A **bay
  projects toward the outdoor side**, read off the `indoor` mask — it has to be the
  same answer every re-flow, or building a shelf flips your bay through the wall.
  And a **wall-sized pane has to ask for its shadow back** (`shadow` on the band):
  glass casts none, which is right for a bottle and wrong for a shopfront, because
  a building whose south face stops laying a shadow reads as the wall having been
  demolished. The day a window *does* something — daylight, charm, a shoplifter who
  can see the till — it stops being a variant, and that is a number on a kind.
- **A floor is a look, and it is what makes a walled room a shop.** Enclosure
  has meant "whatever the walls close in" since step 3 of docs/building.md — so
  you could always draw an annex and it counted as indoors, and it then refused
  every shelf, because the ground was grass and `BUILDABLE_INDOOR` is floor.
  Worse, the refusal read "something is already there", so the missing half
  presented as a bug in the wrong place. The Floor brush is that half: drag out
  an area, priced per cell the way a wall is priced per edge. Two rules keep it
  cheap. It is **not a tile kind** — `tiles` still only ever holds `GRASS` or
  `FLOOR`, and which design a cell wears rides in `layout.floors`, so nothing
  that reads the ground changed and no material can ever move a tile. And it is
  **not in `FIXTURES`** — a floor has no anchor, blocks nobody and is painted
  rather than placed, so `BUILD_KINDS` partitions in three now, which
  `verify:catalog` counts rather than trusting anyone to remember.
- **…and a brush may not take the ground out from under a FIXTURE, in either
  direction — the refusal was asked of the eraser only.** Every word of
  `groundIsBusy`'s argument is about laying too: the generator would not leave a
  hen house standing on a paddock, it would drop the placement on the next
  re-flow and refund it, which is a bulldozer wearing a paintbrush — and undo
  cannot put it back, because what an undone ground step restores is the ground
  rather than the shed placement. A pen stands on GRASS, so `groundIsBusy` never
  fired (grass is exactly what you may paint over) and `blocked` was never
  asked: one press of Muddy Yard over your own pen stamped `T.PADDOCK` and sold
  the building back. Money in, so nothing reads as stolen — what you watch is a
  fixture disappearing under a colour, with no refusal anywhere and no way back.
  The test is whether the **tile moves**, not whether the stroke is laying or
  erasing: a floor swapped for another floor leaves `T.FLOOR` where it was, so
  an aisle can still be redecorated under its own shelving, and the eraser's own
  version of the check should always have said the same thing. It was found from
  a screenshot, which is the tell that no sweep was making the claim: reported as
  "it erases my farm stuff", and the two sweeps that laid a pad indoors were
  *themselves* shedding a shelf to make their point, because they tested the tile
  and not `blocked`.
- **…and a LOOK goes under a JOB, because for as long as one overlay held one
  answer per cell those two were rivals.** `GROUND` has partitioned since the
  yard stopped being furniture — `floor`, `road`, `path` and `lawn` are a look,
  the five pads carry a job — and the brush read neither half: a floor dragged
  across your own stockroom took the storage away. Not refused, and not even
  warned about properly, because **painting over a pad is also how you MOVE
  one**, so `canPaintGround` had no way to tell "put the bay over there" from
  "lay a nice floor through here" — the last-cell warning fired and then the
  thing it warned about happened, and what you notice days later is that
  deliveries have stopped arriving. `groundPaint` (`shared/build.js`) is the
  rule: a look painted onto a job is remembered *beneath* it (`u`, a kind and a
  piece), the job draws and behaves exactly as it did, and taking the job up
  hands the look back. It is `canPaintGround`'s own sentence about a conveyor —
  **under a conveyor is still ground** — said about a pad. Five things about it.
  `k` is still the top and still the only thing that decides the tile, so no
  reader of `tiles`, `blocked`, `indoor`, a pad region or the renderer changed,
  and the inverse shape (the look on top, the job beside it) makes "what is this
  cell made of" a precedence question asked inside a pure generator that has
  never seen the catalog. **One function owns the layering**, called by the
  validator for the ghost and by `buildGround` for the press, because two copies
  of it is the green-ghost bug with a paintbrush: a preview promising a floor
  over a room the press leaves as a stockroom. The pad-loss and bare-cell
  warnings are judged on **where the cell ends up** rather than on what was aimed
  at it, or a floor stroke goes on warning about a bay it no longer takes — and a
  warning that goes off whatever you do is one nobody reads. `u.p` is **never
  null**, so a seeded pad, the generated street and plain shell floor cannot hand
  back ground nobody paid for on a scrape, which is what keeps the money to one
  question: nothing is refunded for a look that went under, since you still own
  it. And `removeSelection` passes **`all`** — a region being deleted is not a
  layer being peeled, and a reveal there leaves a room-shaped stain of perfectly
  good flooring behind the stockroom it just deleted. The general shape, and it
  is this file's third time: **a table that partitions into two kinds of thing is
  a table whose readers have to ask which**, and a reader that does not is not
  wrong about either half — it is wrong exactly where they meet.
- **…and the grass was never drawn, which is not the same as not being
  authorable.** `T.GRASS` is 0 and `buildWorld`'s tile loop opened with
  `if (kind === 0) continue`, so a grass cell never became a mesh: what you were
  looking at was the big apron box underneath, one flat colour, with none of the
  per-cell jitter and none of the baked lamp light every other kind of ground
  gets. Next to a floor you laid — three hundred slightly different creams — it
  reads as the *material* being cheap, which points at the palette, and the
  palette is fine. `GROUND.lawn` fixes both halves at once and costs nothing on a
  live save, because an unpainted cell has no entry in `layout.ground` and
  `surfaceOf` falls back to the tile's own colour. The trap it left behind is in
  the next entry. **A default is the thing nobody notices is missing**: grass is
  what a cell is before anybody does anything, so there was never a moment where
  somebody wanted a second one and found they could not have it.
- **…and a rule phrased against `groundKindOfTile` gained a silent new answer
  that day.** It answered null for bare grass for as long as `GROUND` had no row
  whose tile was `T.GRASS` — which read as a rule ("null means nobody painted
  here") and was a coincidence. Two callers meant exactly that and both broke
  quietly: `canPaintGround`'s erase branch (`if (was == null) continue`) would
  count every cell of a field as a change, charge for the stroke and warn about
  holes where nothing moved, and the server's own skip test would write a
  `k: null` entry per cell and report the lot as taken up. The fix in both is to
  ask the *overlay* rather than the tile — "is a design painted here" is the real
  question, and it always was. Same shape as the `chilled` boolean and the third
  kind of shelving: **a lookup with a `?? null` has a meaning that comes from
  what is absent from a table, and adding a row to that table changes it.**
- **…and a non-uniform scale splits object space into two units, with nothing in
  the file to say which one a number is in.** A grass blade is authored in a unit
  cube and the instance sized it — but only on y, by `blade` (0.13 tiles). So the
  tip offset, authored as `dx * 0.22`, was in TILES while the height it was
  leaning off was in blade-heights: a blade 0.13 tall leaning 0.22 sideways is a
  60° splay in three directions, which draws a yucca. It presents as bad
  modelling and it is arithmetic, and it is invisible in the file because both
  numbers are small and sit two lines apart. `setScalar` is the fix rather than a
  better constant: with a uniform scale, object space is blade-heights on every
  axis and a lean can only be a fraction of a height because there is nothing
  else for it to be a fraction of. `WIND_LEAN` moved into the same space with it
  — in tiles it was invisible on short grass and a thrash on long. Worth asking
  of anything sized per instance: is every number in this geometry in the same
  unit, and what enforces that?
- **…and `tufts` is the second ground pattern that is geometry, which is where
  the cap lives.** `stripes` was the first and the argument is the same one
  turned up: what survives of a flat pattern at 45° is its colour, and the way
  you tell grass from lino is that grass has height. Three things about it are
  decisions rather than optimisations. The scatter is `hash01` and never the rng
  — build mode re-flows on every wall segment of a drag, so a drawn scatter
  reshuffles the whole lawn as you drag and reads as the ground being unstable.
  `MAX_TUFTS` **thins rather than refuses** (every Nth cell), which is
  `lights.js`'s call about the ninth lamp made before there was a catalogue of
  lawns to trip over it, because the alternative is finding it later as "building
  got choppy". And the wind is `onBeforeCompile` on a material of its own —
  never `material()`, which is a cache keyed by colour shared by every prop in
  the game, so hanging a vertex shader on it sets every green thing in the shop
  swaying.
- **…and `surfaceOf` rebuilds its object field by field, so a pattern's new
  number has to be named there or it goes nowhere.** `bars` was exactly that from
  the day it shipped: authored, validated by the schema, printed in
  `docs/fixtures.md`, and dropped on the way to the renderer, so `stripeBars`
  read `undefined` and every crossing in the game was drawn at the default three
  however it was authored. Nothing logs it and the crossing still looks like a
  crossing. It is the "tier that changes no number" trap wearing a surface, and
  the reason it survived is that no seeded row had ever set the field — same
  lesson as `charm`: **whenever a mechanic reads a content column, check how many
  rows have ever set it.**
- **A drag sends the POINTER's far end, never the tail of the list it built.**
  Both build drags send two ends rather than the segments, because the inbound
  cap is 4KB — so the server re-runs the same generator and has to land on the
  same run. `edgeRun` emits lowest-index-first whichever way you dragged, so
  reading the far end back off `segs[segs.length - 1]` is the end you *started*
  on for every drag towards a lower x or z, and the server built a run of
  exactly one. What you saw was eight segments of green ghost and one wall,
  with no refusal and nothing in the log — and the *screen* direction that
  fails changes as you turn the view, so it reads as flaky rather than as
  directional. `showFloorDrag` already carried its own `to` for this reason and
  says so; the wall drag went four steps without it. Anything that previews a
  run locally and sends its ends has to send what it AIMED at, not what it
  computed.
- **The yard is ground you paint, and the mark that it was seeded is a boolean
  rather than a count.** The delivery bay and the drop-off used to be stamped by
  `compose` against the corners of the back wall on every re-flow, which is
  exactly why they could never be moved: buying a shelf put them back. They are
  designs for the floor brush now — one overlay (`layout.ground`, formerly
  `floors`), where the KIND of the piece you painted decides the tile. Two traps
  came out of it. `freezeYard`'s mark has to be its own field, because "does
  this shop own any pads" hands your bay back on the next load the moment you
  paint over the last one — which makes the yard the one thing in the shop you
  may not get rid of. And **the seed may only lay ground the player could lay**:
  the old 2×2 sat half on row 0, the world's border ring, which every build tool
  refuses — a pad you can delete three quarters of is worse than one you cannot
  delete at all, because it looks like it worked.
- **The shop is centred east–west and was never centred north–south.** `storeZ`
  was hardcoded at 2, so there were two rows behind the building and the border
  ring ate one of them. It lives on the stored shell as `shell.z` now: a save
  without one reads 2 and does not move — every fixture in it is a placement at
  an absolute tile, so pushing the building south would drop the entire contents
  of the building outside it and refund them — and a new world starts at 5.
  Anything that changes where the building *sits* has to be opt-in per shop for
  the same reason.
- **Opening is two switches, and only one of them is yours.** `isOpen()` is
  `open && trading()`: the business day is still the world's (08:00–20:00,
  `trading()`), and the shutters can only shut you *inside* it. Pointed the
  other way — a switch that extends the day — never closing is simply correct
  and there is no decision left on the button. Three things read the *clock*
  rather than the shutters and have to keep doing so: the compressed night in
  `step`, `DELIVERY_RUNS`, and the struck-through clock in the HUD — shutting at
  noon must not fling you through the afternoon at 6×. The trap is the default.
  `open` reads **true** when a save doesn't mention it, so no existing shop
  shuts itself; a default of `false` would also shut every headless game —
  `simulate` and every `verify:*` sweep — and a balance run against a shop that
  never opens reports zero with nothing in the output to say why. "A new shop
  starts shut" is therefore written by `createWorld` at creation, not defaulted
  in `Game`, and `simulate` forces the shutters up beside `autoServe`. The
  renderer has to be *told* (`scene.paused`), because `animateStations` is the
  one loop driven by the page's clock rather than the shop's — a blade still
  turning in stopped time reads as the pause not working.
- **…and a new shop now opens the clock at 06:00, which is a frame rather than a
  prep window.** Shut at 08:00 with the town already out is a shop that is
  *late*; shut at 06:00 is one that has not opened yet, and they are the same
  empty floor with a different meaning on the clock — three new worlds got played
  for a while with the shutters down. Be honest about what it buys: `daylight()`
  is 08:00–20:00 and everything outside it runs at `NIGHT_SPEED`, so those two
  hours are about **five real seconds**. The two things that actually say it are
  a log line on the tick `trading()` turns true with `open` false (a
  *transition*, or it is a line every tick of every morning — and `wasTrading`
  starts `undefined` so a save opened at teatime never speaks), and the sign
  pulsing until somebody has worked the shutters once, ever (`sns.shutterUsed`
  in localStorage — it is about the person, not the shop, so a second world does
  not ask again). Two traps came out of it. `time` had to start being
  **persisted**: it never was, so every load began at 08:00 sharp, and
  `createWorld`'s 06:00 would otherwise be re-handed to that world on every
  restart for ever. And the default matters more than the value — `w.time ??
  OPEN_HOUR / 24`, because an ephemeral game has no save, and defaulting a
  headless game into the dark puts every sweep on the 6× clock: `verify:break`
  caught it as a hire who got bored in 4.1 seconds instead of 15, which is the
  `fresh()` trap in its second form again.
- **…and `paused` is saved as a STAMP, because "not saved" quietly meant "until
  the next restart".** It was in memory on the argument that a pause is a fact
  about the person rather than about the shop — like where the camera is
  pointing — and that a save coming back paused would look broken on load. Both
  halves are right about somebody who walked away and wrong about the case that
  actually happens: a dev-mode restart is the same person, at the same desk, two
  seconds later, looking at a shop they stopped. A live save had **six in-game
  days** run past a pause pressed at 18:00, because the server was restarted to
  pick up a code change — and nothing says a word, because a shop that
  un-paused and a shop that was never paused are the same screen. So
  `setPaused` stores `pausedAt` and `pauseHolds` honours it for five minutes:
  a restart comes back stopped, a night off does not. Three things about it.
  The clock is **`Date.now()` and not `elapsed`**, which inverts this list's
  usual trap — `elapsed` restarts at zero on every load, so it cannot measure
  the one thing being asked about, which is time spent with the game *not
  running*. `setPaused` has to **`persist()` itself**, because a paused game
  never steps and therefore nothing else would ever write the save again. And a
  stamp from the *future* reads as not-paused rather than as for ever, or a
  clock moved back leaves a shop that will not start whatever you press.
- **A refusal has to come before the money moves, not after the decision.**
  `buyStock` deducted cash, then checked there was a bay to deliver onto — so an
  order with nowhere to land was refused *and* charged for. It read as correct
  in isolation, because the check itself was right and sat next to the code it
  guarded. `verify:yard` caught it on the assertion that nothing was charged, not
  on the one that the order was refused. Put a new guard with the other guards.
- **…and a refusal is only a message if somebody is reading it.** The same
  guards, one caller along. `buyStock` refuses an order bigger than `bayRoom` or
  `looseRoom` **by name** rather than quietly shrinking it, and its own note
  defends that — a number silently becoming a smaller number is the complaint
  said backwards, and "only room for 60 more at the bay" tells you to go and
  paint some. That is a sentence for a *press*. `restock` and `larderOrder` are
  the other callers and neither has anybody to say it to: `buyStock` logs only
  for `!p.staff`, and both read `.ok === false` as `continue`. So the board is
  skipped, and skipped again next tick, and every tick after, because nothing
  about it has changed — a refusal became a permanent silence. What that
  inverts is the whole shape of the shop: the emptiest board asks for the most,
  so **the bigger a unit is, the more certain it is never to be bought for**. A
  live shop on day 322 had a 216-unit stockroom board standing at zero against a
  bay with 60 free — computed 216, turned down, moved on, for ever — while every
  small old shelf in the same aisle had stock on it, which reads as the ordering
  having broken on the good shelves. Buying more shelving made it worse.
  Painting a bigger stockroom made it worse. The fix is not to soften
  `buyStock`: a job that CHOOSES a number owes it to ask for a possible one, so
  the yard is a third ceiling beside the two money ones, hoisted out of the
  queue loop because both halves of it sweep every crate in the shop. It clamps
  nothing away — `homeSupply` counts a pending order, so a 216 board takes a van
  of 60 today and asks for 156 tomorrow. **The yard is the rate, not the
  ceiling.** The general shape, and it is this file's third refusal trap: *a
  guard written for a player is a guard with an audience, and the same guard
  reached from a job loop is a silent skip.* Worth asking of every `if (!x.ok)
  continue` in `staff.js`.
- **A fixture can earn now, and its clock must not be saved.** `yields` on a
  piece pays into `dropCash`'s pile — the till's entity, renderer and pickup
  path, never a second kind of money on the floor. The trap is the timer: stamps
  are against `elapsed`, which **restarts at zero on every load**, so a saved
  stamp puts the last payout in the future and the thing never pays again.
  `persist` already learned this about `plantedAt` and stores crops as how long
  they *have* grown. `yieldedAt` is in-memory with a `last > elapsed` guard.
- **Every loop that touches stock skips an item it cannot look up, and the sum
  of all that correct forgiveness was goods nothing could ever shift.** Content
  is edited live, so `delete_content` can land while cases of that item are on a
  board, in a crate, in your hands, on a shoulder, in a hopper, in a tray and
  paid for on a van. Not one of those readers is wrong — a lookup that guessed
  would be worse — but the total is stock that can never be sold, shelved,
  spoiled or moved, holding a board and a bay cell for ever. **It is invisible in
  exactly the wrong direction:** a crate whose item has gone renders as a crate
  with nothing in it and the `x12` still on the front, because `syncPallet` has
  no model to draw — so the symptom points at the renderer and the cause is a row
  somebody deleted in another window. And you get there by accident, because the
  verify sweeps author test items into the live shared content database and a
  shop that is OPEN while one runs will buy them: the tags on them are real, so
  the ordering does exactly what the tag system is for. Shop 2 collected 84 units
  of `zz-yard-spud` and `zz-kit-bean` that way, and the tell was not the crates —
  it was `bayRoom` at 6 out of 108 and the shop quietly failing to order
  anything. `binOrphans` collects it at the day roll. Two things about where that
  sits. It is **the roll and not the delete**, because `applyPlacements`
  deliberately lets an unknown item ride on a re-flow and a re-flow fires on
  every wall segment — binning there would be instant, repeated and
  unrecoverable, so the two rules are a pair rather than a contradiction and a
  day is the grace. And it **moves no money and cannot even price what it took**:
  `spoiledValue` needs the row, and the row is the thing that has gone.
- **A pad is a job, and the third one holds people.** The break area
  (`GROUND.break` → `T.BREAK` → `L.break`) is painted with the same brush the bay
  is, and *one cell seats one person* — the yard's "how big you paint it is how
  much it holds", said about staff. Three things about it are not obvious. It is
  the one pad **nothing seeds**, because a shop with no bay is broken and a shop
  with no break room is every shop that exists today. It **outranks the pastime's
  own `spot`** rather than joining `PASTIME_SPOTS`, because a room half your
  hires ignore reads as broken — so `spot` is now the fallback. And the fallback
  has to survive a room nobody can *reach*: the seat search asks `findPath`, or
  walling off your break room pins every hire at `TIRED_PACE` forever, which is
  strictly worse than never having painted one. Measured at +47 mean profit over
  12 seeds beside the door and +12 in the far corner — where you put it is most
  of what it is worth, and that falls out of the walk rather than out of a rule.
- **A shopper who has not arrived is not a customer, and four loops disagreed.**
  A car drives to its space now (`DRIVE`), and back off the map when its owner is
  done (`DEPART`) — so `this.customers` holds people who are not in the shop, and
  every loop over it was written when the only way into that object was to be
  standing in one. `inACar` is the predicate, and the four readers are the crush
  everyone inside feels (`measureOccupancy`), the shop's mood (`moodAverage`),
  the snapshot (or you draw a shopper skating up the road with their arms out,
  inside the car that is also being drawn) — and **`stepMood`, which is the one
  that costs money**. `patience` is a budget the shop draws on and the road is
  not the shop: ungarded, the further away somebody parked the crosser they would
  arrive, and it presents as shoppers storming out of a shop that has done
  nothing to them. The general shape is worth keeping: **a container whose
  membership used to imply a fact stops implying it the moment something can be
  in it earlier**, and nothing about the old readers looks wrong afterwards.
- **…and a re-flow parks a car rather than restarting it.** The van's answer to
  a lane that moved is to go home and come back, which is right for a lorry that
  reappears six in-game hours later and wrong for a car, because a player who is
  *building* re-flows on every wall segment: a car that began its approach again
  each time never arrives at all, so the shopper inside it is a customer who
  never happens — in a shop being extended precisely because it is busy. And a
  car set down at the facing it was *travelling* is parked across its bay, since
  a lane's last leg runs along the road; `parkNow` puts it on the cell at the
  facing worked out when the space was claimed, which is the one thing in the
  whole step that IS visible in a screenshot.
- **A pavement is the same idea for feet, and `findPath` now CHARGES a step
  rather than counting one.** `T.PATH` — the strip the generator lays from the
  door — has been in the game since before ground was paintable, so "add
  sidewalks" was one `GROUND` row and no new enum, colour or renderer code. The
  two constants in `server/sim/pathing.js` mirror the road's: paving 1,
  everything else outdoors 1.25, and **the preference must never be cheaper than
  an ordinary step** — `h` is Manhattan distance, which is admissible only while
  no step costs less than 1, so a discount on paving quietly turns A* into
  something that returns *a* route rather than the shortest one. The surcharge is
  **outdoors only**: nothing indoors is ever pavement, so a uniform one in a shop
  would change every score, leave every ordering identical and cost real time, on
  the hottest loop in the game. And 1.25 is not a *speed* — what a step costs the
  search and what it costs the walker are different questions, and nobody moves
  faster on paving; making it a speed turns a look into a balance change.
- **…and a crossing is a design, not a kind.** `T.PATH` is in `DRIVABLE` and
  always has been, so pavement painted across a lane is drivable *and* the thing
  feet prefer, which is exactly what a pedestrian crossing is. It cost one
  `surface.pattern` (`stripes`) and no code that knows what a crossing is. Before
  authoring a new kind for something, check whether two kinds you have already
  overlap on it.
- **A car was smaller than the person driving it, and that reads as the ground
  being wrong.** The `shopper-car` model was 1.16 × 0.62 tiles against a person
  0.68 across. What it *presented* as was roads and parking that felt out of
  scale, which is the trap: an art bug one file away shows up as a complaint
  about level design. Vehicles are 1.75× on the floor plan now (x and z only —
  a car as tall as it is long is a bus), and the ground grew to match, because
  a 1.21-wide car hangs off a one-cell lane. Two rules came out of it. A road
  stroke is `ROAD_THICK` cells thick whatever you dragged, decided inside
  `groundStroke` because the ghost and the server both run it and the client
  sends a drag's ENDS rather than its cells — a width rule in only one of them
  is a green ghost promising a road the shop refuses. And **a parking bay is two
  cells**, paired in `parkSpaces`, with the bay owning its own `mid` and
  `facing`: `parkedAt` stays the anchor cell because that is the tile A* can
  route a driver out of, while the car stands on the line between two of them. A
  lone cell is not a bay. `PARK_HALF` halved with it — the geometry changed and
  the balance was not meant to.
- **…and a lorry has an END that goes at the dock, which "one cell short" never
  said.** Two bugs in one place, and the second only became visible once the
  first was fixed. `vanRoute` has always docked the van a cell out from the bay
  and its comment says why — goods land on the pad, and a van parked on the
  crates it has just set down is a picture of the wrong thing. One cell *was*
  that promise while a lorry was 1.56 long; at 2.73, with the anchor nowhere
  near the middle, the same lane parks it 0.76 into the bay, three quarters of
  the way across the crates. That reads as the pad being in the wrong place
  rather than as a lorry being longer. And it arrived **nose-first**, because
  `followPath` faces everything the way it is travelling — a model is authored
  nose-east, so the load bed is its `-x` end, and the shop was taking delivery
  out of the van's bonnet. `Game.vanStop` answers both: it **reverses** the last
  leg and sets back by the *tail*, measured off the art (`modelExtent`, unioned
  over every stage, so a full van and an empty one halt in the same spot).
  Backing in costs no manoeuvre — the corner is still a 90° turn off the ring,
  just the other way, and pulling out is a straight drive forward, so there is
  no turn on the spot at either end. Four things about where the pieces live. It
  is **not** in `vanRoute`: a lane is a property of the *shop*, whole tiles
  computed once per re-flow, while which lorry is coming is content nothing
  knows until one is sent. `van.dock` therefore stays the lane's own whole tile,
  because `regenerateLayout` compares it to ask whether the lane moved, and a
  fractional setback there would read as a lane that had gone on every single
  re-flow. The reversed heading is a **field on the van** applied in `driveVan`
  rather than a flag `followPath` reads — that function is what people walk
  with, and a pedestrian who reverses is nothing anybody wants. And `out[0]`
  gets the setback too, or pulling away begins with the van lurching *forward*
  over the crates. A bay hard against the border ring gets none of it —
  `laneVia` collapses the turn there, so the van halts alongside the pad rather
  than end-on, and there is nothing to reverse into. The sideways 0.145 of
  overhang per flank is left alone: `ROAD_THICK` is the deliberate answer to
  width, and tightening what `drivable` demands would take the lane away from
  shops that have one, which lands as deliveries that teleport.
- **The starting world has a front now, and only a NEW one does.** Yard behind,
  fields down the east flank, street across the bottom (`defaultStreet`, laid by
  the same one-time mark `defaultPads` is). It could only ever be new worlds:
  every fixture is an absolute tile, so moving the building would strand a live
  shop's contents outside it. `FRONT_DEPTH` is the agreement between the farm
  loop and the street — 8, which is exactly what the starting shop already had,
  so a shop that has not grown comes out where it always did. No car park is
  seeded, and that is `parkReach` feeding `catchment` rather than tidiness.
- **A road is a preference, and the border ring is not yours to paint.** Every
  outdoor cell has been in `DRIVABLE` since the van first drove, so `T.ROAD`
  cannot grant permission and does not try — `ROAD_COST` 1 against
  `OFF_ROAD_COST` 2 only changes which legal lane is *chosen*, and with no road
  painted every candidate scales by one constant, so no existing shop's lane
  moves. The half nobody predicts: `canPaintGround` refuses row 0 and column 0,
  which is exactly the border ring, so the leg *along* the border can never be
  tarmac. What you price is the **spur** — and that is the better design said out
  loud: the ring is the public road and you cannot pave it because it is not
  yours; what you paint is the driveway, which is what decides which side of the
  map anything arrives from.
- **`charm` feeds catchment, and the ceiling is the point.** Reputation is what
  the people who already came in think of you and the shop can max it out;
  catchment is how much of the town is in reach at all, which is the term
  shopkeeping could never move. Charm is content-authored and unbounded, so the
  curve saturates at `CHARM_MAX` — otherwise the cheapest strategy in the game
  is a room full of pot plants. It is also the first thing that has ever read
  the `decor` upgrade kind, which sat in the schema dead since it was written.
  **A working system with no content in it is indistinguishable from a broken
  one**, and this was that for as long as it existed: `charm` was authored on
  exactly ONE row in the catalog (`money-tree`, 4.0), so eighteen decorations —
  every lamp, planter, awning and sign in the game — were worth nothing, and a
  shop with fourteen awnings up reported a charm of zero. Nothing is wrong in
  the code and nothing logs anything; what it reads as is decorating not doing
  anything, which is the same picture as decorating not being implemented. The
  tell was a milestone asking for ten charm that no amount of building could
  reach. Worth checking, whenever a mechanic reads a content column: how many
  rows have ever set it?
- **…and charm buys the MOOD people walk in on as well, which is the half that
  is about the room rather than the map.** Reach is a bet on how many people
  come; it says nothing about what the inside of the shop is like once they are
  through the door, so a bare concrete box and a shop with fourteen awnings up
  played identically from the threshold onwards. `MOOD_BASE` (0.72) is the
  walk-in now and `moodBase()` closes the gap to 1 on the *same* saturating
  fraction `charmReach` scales — deliberately the same curve, because one lot of
  charm is one fact about the shop and two curves would mean a room lovely enough
  to widen the town but not to cheer anybody up. Two knock-ons are the point
  rather than side effects: `stepMood` drains a budget that now starts lower, so
  an ugly shop has less slack for a queue, and a sale is worth
  `0.008 * (mood - MOOD_ANNOYED)`, so an ugly shop earns its name more slowly off
  the same trade. It is read at the door (`spawnCustomer`) and never stored, so a
  planter helps the next person in rather than the queue already inside. The trap
  it sprang is the `fresh()` one in its second form: `verify:park` asserted a
  driver arrives at `mood === 1`, which was two claims wearing one literal — the
  one it is actually about is that the DRIVE changed nothing, so it compares
  against what they set off with now.
- **…and reputation moves through ONE function, so that it can leave a
  receipt.** Six places wrote `this.reputation = clamp(this.reputation ± x)`
  directly, which is correct and tells nobody anything: it is the slowest number
  in the game, footfall is downstream of it, and a shop sliding from 70% to 40%
  over a week had seven mechanics to guess between — which in play reads as the
  bar moving on its own. `Game.moveRep(delta, cause)` is the only writer now and
  the tally (`stats.repMoves`) is a byproduct of the write rather than a second
  set of books beside it, so it cannot drift from the number it explains. Three
  things about it. What is banked is what LANDED — the clamp first, the
  difference tallied — so a shop already on the floor honestly reports that
  another storm-out cost it nothing. The causes live in `shared/reputation.js`
  and the keys are constants, because three readers have to agree about them and
  a typo would open a silent eighth bucket that every readout prints as a raw
  key. And the tally is raw in memory and **rounded on the wire**: `crowd`
  accrues a few ten-thousandths every tick a shop is packed, and the Shop
  panel's refresh test is a stringify of `stats` — so the unrounded float would
  redraw the report ten times a second for as long as the shop was busy, which
  is the one state in which somebody is reading it. Spoilage is deliberately not
  in the list: rot costs money, and nobody who walked in today ever saw it.
- **A tile is ground. What is standing on it is `layout.blocked`.** They were
  one array until step 5 of docs/building.md, which is why there was nowhere to
  put a rug — a rug is not a floor material and not an occupant, and one value
  has no third answer. `FIXTURES` says `blocks` as a field now, and a plot says
  `ground: T.PLOT` because a bed doesn't stand on the floor, it *is* the floor.
  The enum numbers in `shared/tiles.js` have gaps where `SHELF`, `FREEZER`,
  `CHECKOUT` and `STATION` were, and closing them would turn every live shop's
  floor into grass — a save holds `tiles` as raw numbers.
- **A shop is stamped once and then stays put.** `Game.freezeShell` turns the
  generated shop into placements the first time a world opens, and the size of
  the building becomes `world.shell`. After that the generator only re-applies
  what is there, so buying a shelf can't shuffle your aisles and
  `droppedPlacements` can't fire on a purchase. The shell has to be *stored*:
  with every fixture a placement the budgets are zero, so a size search would
  find that a 9×9 holds everything asked of it and shrink the building back,
  stranding every placement outside. Which also means **`fresh()` in the verify
  scripts has to clear `g.shell`**, or the sweep asks a 10×9 shop to hold a
  10×11 shop's shelving and gets a layout with no shelves in it. It also has to
  say what to furnish *with*: `regenerateLayout(null, {}, { want })`, since the
  ledger it used to pin (`g.fixtures = {...SHOP}`) is gone.
- **The `fresh()` trap has a second form: state that isn't new, but newly
  matters.** Every sweep resets what `Game.create` reads off the save, and the
  list grew by `edits`, then `shell`. `ownedUpgrades` never needed resetting
  because owning one couldn't change what anything *cost* — since step 9 it can,
  so `verify:economy` clears it, and a run that didn't would measure a
  discounted shelf against an undiscounted literal and call it a pricing bug.
  Ask what a save could now leak into your assertions, not just what fields you
  added.
- **…and the mirror of it: `Game.create` does not spread the save, it NAMES
  every field.** So a new save field needs writing in two places — `saveState`
  on the way out and that payload on the way in — and forgetting the second is
  the quietest failure in this file. The world persists the value, reloads
  without it, and the constructor's `??` fallback answers instead: the menu, the
  API and `list_worlds` all read the save directly and report the value
  correctly, while the sim has never heard of it. `difficulty` shipped that way
  for an hour, and what gave it away was three difficulty presets returning
  **byte-identical** takings over three seeds. **`paint` shipped that way for
  five steps**, and it is the worse form of the same bug: the constructor's `??`
  answered `{}`, and the next `persist()` wrote that empty object back over what
  was stored — so a restart did not fail to restore your paint, it *deleted* it,
  while the save looked correct in between. `verify:paint` asserted the save
  CARRIED it and stopped there, which is why a sweep written for this exact
  layer passed for the whole life of it: **out and back are two different pieces
  of code, and only one of them is obvious.** Every `verify:*` sweep passed
  either side of it, because every sweep builds its own world and every one of
  those genuinely is the default. A round trip that comes back suspiciously
  equal is the shape this makes.
- **A decoration weighs nothing, on purpose.** `prop-floor` and `prop-ceiling`
  stamp no tile, take no generator budget and reserve no working spot, so people
  walk past them and no shop that was walkable stops being so. That is why there
  is no authored `blocks` flag: a barrel that stops nobody is a lie you can see,
  and one that stops people needs to own its cell — which a tile cannot say
  alongside "floor". Anything that must be walked around is a shelf today.
- **What the shop owns is the shop, not a number beside it.** `world.fixtures`
  was a stored count per kind, and it had to be while the generator furnished the
  place itself: "six shelves" was a number nothing in the world could be read
  back from. Step 4 made every fixture a placement and step 9 retired the ledger,
  so the count is `Game.fixtureCounts()` — a recount — and it cannot double-count
  a freezer on a restart or forget one you tore out, both of which the ledger
  managed. `countKey` in `shared/pieces.js` is the one spelling of the key, and
  the client imports it, or the palette would print 0 next to eleven shelves.
  Its predecessor `ledgerKey` had to spell a fixture by KIND and a prop by PIECE
  — the budget needed it — and that asymmetry retired with the budget.
- **Eight lights, and the cap is not a tuning knob.** three.js forward-renders
  every light against every fragment, so lights multiply the cost of the scene
  rather than adding to it. `client/render/lights.js` keeps a fixed pool, aims it
  at the nearest emitters, and folds the rest into ambient so panning sharpens
  the near end of the shop instead of switching the far end off. Also: three's
  falloff makes `intensity` a power, not a brightness — a lamp authored as "1
  over 4 tiles" is invisible until it is scaled by range squared.
- **A line found in the PICTURE can never be sharp, and no amount of tuning the
  threshold changes that.** The ink pass reads the finished frame, which is what
  makes it free for every fixture anybody ever authors — and both of its
  detectors answer one of two numbers per pixel, so the mask is binary and every
  diagonal is a staircase. `creaseAt` reads a half-res normals buffer on
  `NearestFilter`, so across a panel lip it is ~1.35 or ~0 with nothing between;
  `silAt` reads a depth buffer that MSAA resolves with a NEAREST blit, so a
  pixel is next to the discontinuity or it is not. `SCENE_SAMPLES` cannot help:
  it smooths the COLOUR edge, and the line is then painted over it out of a
  buffer resolved to one sample. Two dead ends were walked before that was
  understood, and both are written down in `INK.SHARP` because both look like
  the answer. Widening the smoothstep does nothing to a value that cannot vary.
  Supersampling the detector does nothing either — a depth texture is not
  linearly filterable in WebGL2, so a sub-texel offset snaps back to the texel
  it started in, and whole-texel offsets are a blur of the mask: five times the
  taps for a fatter, softer line, which is the grey smear the dial is warned
  about arriving by the back door. FXAA on the composed image is a treatment
  rather than a fix, and it is there because it leaves the line's WEIGHT alone.
  The fix is that interior lines stopped being found in the picture at all:
  `collectEdges` cuts them from the geometry (`EdgesGeometry`, cached against
  the shared primitive, merged into ONE `LineSegments` for the whole shop, which
  is `weld`'s argument said about draws) and they are resolved by the same
  `SCENE_SAMPLES` as every other edge. What that costs is everything the screen
  pass got free: WebGL ignores `lineWidth`, so there is one weight at every
  distance and `INK.FADE` has nothing to act on; an edge only exists where an
  object meets ITSELF, so it can draw no silhouette; and a part that moves takes
  its lines nowhere, which is why `userData.moving` is skipped. **The two are
  answers to one question and never two layers** — with both on the drawn line
  lands underneath the screen one and the whole thing reads as the geometry pass
  having done nothing, which is exactly what it looked like for one round of
  testing. So `Ink.setCrease` stands the screen crease down, and the silhouette
  is untouched either way. The half nobody predicts: the normals buffer had
  exactly ONE reader, so turning creases off does not trim the ink, it deletes
  the second full draw of the shop that was the ink's entire cost — `wantsInk`
  gates on `creaseInk` for that reason and not for tidiness. What it does NOT
  cover is anything the fixture loop does not build: walls keep whatever the
  silhouette gives them, and the crowd never had creases anyway, since
  `inkNoCrease` has held `actorRoot` out of the normals pass since it existed.
- **A rule written as a boolean over two kinds is silently wrong the day there
  are three.** A unit of shelving could be a shelf or a freezer, so every
  stocking rule in the game was some spelling of
  `(itemIsFrozen) === (shelfIsFreezer)` — correct, and correct only while there
  is nothing else a shelf can be. The hot counter is the third, and nothing
  about those eleven call sites *looks* wrong afterwards: a warmer answers "not
  a freezer", so it reads as ordinary shelving, accepts bread, and refuses the
  roast chicken it exists for. `STOCK_KINDS` and `shelfKind` are the one
  normalisation now, and `homeKind(item) === shelfKind(unit.kind)` is the whole
  rule — `homeKind` is *total* (an item that asks for nothing asks for `shelf`)
  precisely so the third state stops being one every caller has to remember.
  The same shape is why `spoilRate` takes a kind rather than `chilled`: a
  boolean has no way to say "in the wrong special fixture", so a chicken in a
  freezer came back as `chilled: true`, which meant "where it wants to be".
- **…and the two bugs that found were both a list of kinds written out by
  hand.** Neither is a stocking rule and both present as the same thing: you
  buy a hot counter, it is charged for, and it is gone. `makeShelf` normalised
  with `kind === 'freezer' ? 'freezer' : 'shelf'`, and every player-placed unit
  goes back through it on every re-flow — so the counter survived being built
  and was demoted to plain shelving by the next purchase, taking its stock onto
  a unit that should never have held it. And `compose`'s budget map was four
  literal keys against a check that reads `if (!(budget[p.kind] > 0)) shed(p)`,
  so a kind with no line was dropped and refunded by the re-flow the purchase
  itself triggers — money back, so nothing looks stolen, and what you see is the
  shop refusing something it had just accepted. Both derive from `FIXTURE_KINDS`
  now, along with `budgetOf`. **Anything that enumerates kinds and has a
  fallback is a place a new kind dies quietly**, because the fallback is always
  the sensible-looking one.
- **…and the rule went two-way in the end, because a MIXED container makes the
  choice for you.** For two steps `holds` was the shop's rule alone — the staff,
  reservations, the re-flow and the balance bot refused both ways, and your own
  hands refused only goods that had NAMED a fixture. Standing a loaf in a
  freezer was your business, `spoilRate` had an opinion about all six
  combinations, and the asymmetry was argued for as a freedom. What retired it
  is that a crate holds several things and `pourInto` empties it pile by pile:
  a box of carrots and eggs tipped into a freezer spent a cold board on the
  carrots and left the eggs in the box, with nowhere else in the shop to be.
  One press, no refusal, and it reads as the shop choosing wrong — which it is,
  because you asked it to fill a freezer. **The fix that does not work is the
  interesting half.** Ordering the piles so the ones that can only live here go
  first was tried and shipped, and it decides which pile goes on FIRST while
  saying nothing about the second: the freezer still filled its spare boards
  with produce, one board later. There is no ranking that expresses "and then
  stop", because the thing being asked for is a *refusal*. So `boardFor` asks
  `homeKind === shelfKind` now and `shelfAccepts` moved with it — the chevrons,
  the press and the staff are one rule, or the highlight promises a unit the
  press turns down. Two consequences worth knowing. The refusal has to be
  `assignShelf`'s **pair** rather than one message: "needs a freezer" tells you
  what to buy, and the new direction has to say "doesn't need freezing" instead,
  because naming the fixture the goods want says "needs a shelf" at somebody
  holding bread. And `spoilRate`'s six combinations are **not** dead — content
  is edited live, so an item can be tagged `needs-freezer` while cases of it
  stand on ordinary shelving, which is what the re-flow's shed is for and why
  that shed had to conserve before this could be changed at all.
- **A break outranks the job list; a CHARGE does not, and that inversion is the
  whole feature.** Anything above the bottom rung takes itself off to the break
  area after 15s with nothing to do (`tryCharge`, `server/sim/staff.js`). If it
  held the tick the way a tired break does, promoting your clerk would buy you a
  till nobody is on for twenty seconds at a stretch — a shop that gets *slower*
  when you spend money on it, with a bot in the break room as the only clue.
  `onBreak` hands the tick back while `idleCharge` is set, whatever the draw
  takes calls `endCharge`, and the energy credit is pro-rata. Three things it
  cost, each invisible: the boredom clock must NOT be cleared when the charge is
  decided (the walk to the room takes ticks, and a hire who arrives no longer
  bored charges fifteen seconds later, in the break room, where it looks fine);
  `idleCharge` has to be set where the pastime is rather than by the caller, or
  the ticks spent walking are a charge that outranks the job list; and `idle()`
  had to learn not to walk a charging clerk back to their till. `simulate` is
  blind to all of it — the balance bot never promotes, so every hire in a run is
  on rung 1 and the rng stream is untouched.
- **…and a QUEUE outranks the draw, which is not the same as serving being
  heavy.** A weight says two things at once — a share of the day and a priority
  — and `drawOrder` only ever spent it on the first. The head is drawn in
  proportion and tried FIRST, so a clerk authored `serve 9` with six odd
  directives at 1 draws a weight-1 job as head **two ticks in five**, and the
  `FALLTHROUGH` floor at half of 1 lets everything else in behind it: a ripe
  bed, a crate on the dock and a shelf that wants filling all outranked a
  shopper standing at the counter. Then `stepStaff` walks before it re-decides
  anything, so the hire is gone for the whole round trip. Measured on that list
  over 20 in-game minutes: away from the till for **85%** of the ticks somebody
  was in the line, against 23% for a hire whose only job is serving, with the
  line lasting 5.6x longer for it. **It is invisible as a bug and obvious as a
  personality** — nothing logs anything, the hire is visibly working the whole
  time, and what it reads as is a bot who cannot see the queue. So `serve` moves
  to the FRONT of the order while anybody is lining up, which is the shut-shop
  exception in the same function pointed the other way, and moving it rather
  than pre-empting the list is the whole care needed: `serve` still guards
  itself, so a farmhand authored `serve 1` still spends their day in the field.
  Two things it needed underneath. `lining` counts anybody whose place in the
  line is theirs, **walkers included** — `leaveShop` re-paths the whole queue
  into `TO_TILL` after every sale, so a predicate reading only `QUEUE` answers
  "nobody waiting" for the length of every shuffle and releases the clerk
  between two customers. And a hire standing at a post with nobody in the front
  slot yet has to hold the tick without being *charged* for it (`tend`, the
  mirror of `stall`): `spend` is one job's worth of wear, and at `DRAIN` a tick
  a wait would flatten a full tank in ten seconds, which reads as a clerk who
  takes a break every time the shop gets busy. `simulate` is nearly blind to all
  of it — `autoServe` is a bot welded to every till, so a balance run always has
  one and the clerk's serving is decorative there, which means what it measures
  is the knock-on to *stocking*: which other jobs the clerk does instead. Thirty
  seeds of a real save moved **−533 → +2231** mean profit (sd 4427 → 4138, so
  ≈2.5 standard errors). **Ten was not enough and said the opposite** — the
  first run read 1133 → 262 with the spread apparently tripling, and both halves
  of that were the sample rather than the change. At this variance the *before*
  arm alone swings from +1133 to −533 depending which ten seeds you draw, which
  is CLAUDE.md's own "one seed is not a measurement" holding at n=10.
- **…and serving is the one goods verb that moves no goods, which is why it
  never needed a free pair of hands.** `serve` opened `if (s.carry) return
  false`, and that was the refusal that quietly undid everything above it: a
  hire who had picked up an armful was out of action as a clerk however far up
  their list serving sat, which on a shop-hand's directives is most of the day.
  Hands were full for **1,790** of the ticks the reported clerk spent away from
  a line, second only to being mid-errand. `Game.serve` finds the front of the
  line and calls `completeSale`, and neither touches the server's arms — so the
  tell that this was an accident rather than a decision is that YOU were already
  exempt: `serveCandidate` has never asked about `p.carry`, so the shopkeeper
  could always ring somebody up holding six loaves and the crew could not. Same
  shape as the chevrons and `shelfAccepts`, and the last place the shop's rule
  and your hands' rule were two rules. A crate on the SHOULDER stays refused,
  and the line is worth keeping: `stepStaff` answers `s.haul` above the draw
  entirely because that branch is the relief guarantee that stops anybody being
  welded to a box — serving is a job you may do with your arms full, not one you
  may be *drawn onto* carrying a crate nothing else will lift.
- **…and the shopkeeper is a person the crew could not see.** `claimed` walks
  `game.players` and skips everybody who is not `staff`, so a player stood behind
  the counter ringing people up was invisible to the hire whose whole job that
  is — and with serving now winning the draw, the two of you crowd one counter
  while the shop goes unstocked. `minded` is the test and it has to be a
  **place** rather than an action: a sale is a ring that arms, fires and is gone
  inside a second, so a clerk asking "are they serving right now" stands down and
  comes back between every customer, which is worse than not asking. It is the
  TEND side at `goTo`'s own reach and deliberately not `serveCandidate`'s 2.2 —
  that circle takes in the customer side, the queue and the unit next door, so it
  would stand a clerk down because you were filling the freezer two tiles away.
  And it is off under `autoServe`, which is the one thing here that had to be
  measured rather than reasoned about: `simulate`'s bot TELEPORTS to whatever it
  is stocking and sat on a till's working side for **14.2%** of all ticks over
  three 60-day runs, so unguarded this would stand the clerks down for a seventh
  of every balance run for a reason unconnected to anybody serving anybody.
- **`till`, `sow` and `harvest` were never three decisions, and the fold is a
  MAX rather than a sum.** They are three steps of one loop over the same beds
  — nobody has ever wanted the middle one on its own — so they cost three lines
  of a twenty-point budget for a decision with one sane setting. `farm` is that
  setting, and the order inside it is not tunable: picking frees a bed and puts
  goods where they sell, sowing is one action from producing, and breaking new
  ground produces nothing, which is the rule `till` has enforced about itself
  since step 2 said about all three. `foldJobs` (`shared/jobs.js`) reads a list
  written when it was three, at three boundaries that are three different kinds
  of thing — `content()`'s `load()` (DB rows never revalidate on read),
  `Game.create`'s roster (a hire's list is *theirs*, so the catalog fold never
  reaches it), and `WorkerSchema` as a `z.preprocess` (so `npm run seed`
  migrates the data rather than being refused by the enum). The max is the trap:
  `drawOrder` pulls a hire whose drawn job has nothing to do no further than
  *half* that job's weight, so summing the farmhand's authored 10/8/6 into 24
  puts their `shelve` 8 out of reach — and every draw that found the beds empty,
  which is most of them, would leave them standing still. That is the "four idle
  specialists" failure `FALLTHROUGH` exists to prevent, arriving as a farmhand
  who stopped working. **Whenever two directives merge, ask what the combined
  weight does to the rule that reads weights as a ratio**, not just to the total.
- **A rule may only read a SPOT where its answer cannot churn.** `spotScore`
  says how good a place a unit is standing in — passing trade against the shop's
  own average, times the endcap — and the obvious place to put it is
  `shelvesFor`'s sort, which is where the shop decides which unit an armful goes
  on. That cost **−72% mean profit over three seeds** against one frozen world,
  one of them a quarter of its units sold. The sort decides where an item's
  stock lands every delivery for ever; footfall drifts, so the order drifts, and
  an item whose best-ranked unit changed on Tuesday starts a second home on a
  shelf it has never been on — the "one item, two homes" spiral `homeShelves`
  exists to close, arriving by a route that function cannot see. Every step is a
  worker correctly shelving goods on a unit with room. Where a spot IS safe to
  read: at the point of sale (the shelf is already stocked, so the reading moves
  nothing), when choosing what to put on a bare board, and in `rearrange`, which
  has hysteresis precisely so it cannot chase a drifting number.
- **…and the mirror: `rearrange` may not ASK `shelvesFor`.** Same rule pointed
  the other way. That function answers "where does the shop keep this", and
  since `homeShelves` it answers with the item's ONE home — so the only unit it
  can ever offer a rearrange is the one the stock is already on, and the verb
  ships doing nothing at all with no error anywhere. It asks `boardFor`
  directly, which is the same legality test `stockShelf` uses. Bypassing the
  home rule is safe **here and nowhere else**, and the reason is the guard above
  it: the move takes a WHOLE board and `clearStack` takes the old one away, so
  the item has one home before and one after. Anything that could move part of a
  board would open the spiral by the back door.
- **A radius over the shop floor is set by the SHELF PITCH, not by feel.**
  `TRAFFIC_REACH` was 2.2 on the perfectly good reasoning that a shopper
  crossing the end of an aisle passes every unit in it. A generated shop stands
  its units one and two tiles apart — 11,7 beside 11,8, the next aisle at 13 —
  so at 2.2 every unit in a small shop is credited for every step anybody takes
  in it. The map is then *perfectly correct* and says the same thing about all
  six shelves, which reads as the feature not being finished rather than as a
  number being too big. At 1.4 the aisle between two facing units credits both
  and the next aisle over gets nothing, which is the distinction the whole
  measurement exists to make. Worth asking of anything new that sweeps a radius
  over fixtures: **can it tell two neighbours apart?**
- **A tier stat can switch a whole branch OFF, and `carry_mult` was doing it.**
  `wholeCrate` refuses a box that is not worth more than one armful —
  `lotTotal(pallet) > hands`, which is right while an armful and a crate are the
  same journey made two ways. It stops being right the moment a rung's
  `carry_mult` reaches a whole crate, and the shipped stocker's second rung
  already does: twelve-unit hands against a twelve-unit crate is `12 > 12`,
  false, for ever. So the one hire you would promote *to* run the back was the
  one hire who could never shoulder a box, which is a rung that takes money and
  moves no number — and it is worse than neutral, because big hands do not help
  with a bay of part-crates at all: `Game.unload` sweeps ONE box and `fillHands`
  tops up only kinds already held, so a twelve-unit stocker facing three boxes
  of four leaves with four, exactly as a six-unit one does. `bar` is the fix —
  a packer's box has to beat `best`, the armful this bay can actually assemble
  (`fit`, already computed two lines up), rather than the size of their hands.
  The general shape is the one `LOT_KINDS` and the third kind of shelving have:
  **a comparison between two quantities is a rule only while nothing can make
  them equal**, and a multiplier on a ladder is exactly the thing that can.
- **…and `lotStacks` hands back COPIES, so a field written onto what it returns
  is written onto a value nobody keeps.** It says so — a caller that sorted the
  result must not be reordering somebody's hands — and it is a trap for exactly
  one kind of caller: anything writing a *stamp* rather than reading a quantity.
  `packCrate` has to carry a pile's spoilage clock across (the older stamp wins,
  or packing is the way to beat rot), and written through `lotStacks` it reads
  as the clock silently not carrying — which is the bug being fixed, wearing the
  fix. `splitOverfull` already sidesteps it by writing `box.stacks[0].day`
  directly, and that is the pattern: **read through `lotStacks`, write through
  `.stacks`.** The same mistake in a *sweep's setup* is quieter still, because
  the assertions then pass or fail for a reason unconnected to the code under
  test.
- **A hire's weights were RELATIVE, and are now also a budget.** `stepStaff`
  draws from the list in proportion, so `serve 10, tidy 1` and `serve 100,
  tidy 10` are the same worker — which is why the absolute size of the numbers
  could be anything, and why the seeded kinds total anywhere from 11 to 33 with
  nobody having chosen a total. `shared/jobs.js` gives that sum a meaning it did
  not have (you cannot max every directive; a rung buys +8), and the trap is the
  floor: the cap is `max(JOB_POINTS, what the KIND was authored with)`, because
  any flat number below 33 hands you a farmhand who is over budget the day you
  hire them. Over budget is a state you can be in — a rollback puts you there —
  and never one you can move further into, or `demote` would silently rewrite
  somebody's shift.
- **A tier that changes no number is a button that takes money and does nothing.**
  `capacity_mult`, `keeps_mult`, `speed_mult`, `unattended`, `lines`, `covers`
  and `heads` are the only knobs the sim reads. The till ladder was priced at 0 for exactly that reason until
  `serveSeconds` gave a checkout's speed something to mean — see the `speed`
  upgrade kind for what happens when you forget (it sells, and `speedMult()`
  still hardcodes `boots-1`).
- **Every ladder goes down, and the refund is of the rung you step OFF.**
  `downgradeFixture` and `demote` are the way back off a tier and off a grade,
  at `FIXTURE_REFUND` — the shop's one sell-back rate, which is why a constant
  with `FIXTURE` in its name is imported by the worker menu. Refunding the rung
  you land *on* is the trap: rungs get dearer as they climb, so half of the
  cheap one back for stepping off the dear one is a press you can run with two
  keys. Two more things are only visible here. A tier is not only a multiplier —
  `boardsOf` reads the art *at the tier* (the freezer draws 2, 2, 3), so going
  down can take away how many KINDS a unit holds as well as how much of one, and
  `tierShortfall` refuses with the guards, before the money, the way `buyStock`
  had to learn to. And a *grade* is the one rung charged again every morning
  (`wage_mult` in `payWages`), which is why the way down is a standing decision
  rather than an undo — and why the worker menu prints the wage at their rung
  rather than `kind.wage`, which is what a NEW hire costs and stops being true
  the moment anybody is promoted.
- **A fixture the sim ticks is not the fixture the menu shows you, and the
  difference is one field.** `findFixture` hands back a *copy* with `kind`
  stamped on it, so the price, the fixture menu and the upgrade button have
  always been right. The sim reads the raw record out of `layout.checkouts` /
  `.plots` / `.stations`, and `pieceFor` matches on `piece` **and** `kind` — so a
  constructor that forgets `kind` resolves to no catalog row at all and
  `fixtureStats` answers 1/1/1. Three of them did: the Commercial appliance sold
  `speed_mult: 2` for $340 and the Raised Bed sold `1.6` for $90, both delivering
  nothing, for as long as they had existed. Nothing renders it and nothing logs
  it — the machine still works, it is simply never faster — so `verify:till`
  sweeps every fixture in a furnished shop and asserts the two resolve alike.
- **A self-checkout is a number on a tier, not a kind of its own.**
  `unattended` (0..1) is what share of its speed a till manages with nobody
  behind it, so `selfServeSeconds` is a comparison rather than a branch: every
  till answers it, and one that needs a person answers `Infinity`. What the top
  rung sells is *not needing a clerk*, which `simulate` can never measure —
  `autoServe` is a bot welded to every till, so a balance run always has one.
  The rung is deliberately slower at the counter than the one below it, or the
  ladder ends in a strict upgrade and there is no decision left on it.
- **`canPlace` gives two kinds of no, and only one of them is a no.**
  `ok: false` is physics — the tile is taken, it is off the map, a plot is
  being dug indoors. `ok: true` with a `warn` is a *consequence*: you may wall a
  shelf in, seal your own doorway, or stand a till where nobody can queue, and
  the game tells you what it will cost instead of refusing. That is deliberate —
  blocking your own shop is a move, and the sim already copes (a shopper who
  can't path to a shelf writes it off and picks another, one who can't reach the
  door leaves, staff cool down and find another job). The one caller that must
  still refuse a warning is the layout generator, which is why
  `canPlaceCleanly` exists: a procedurally furnished shop nobody can walk
  through is a bug, not a choice. `verify-build` uses it for the same reason.
- **…and the generator has to honour a warning it did not issue.** `compose`
  re-judged *player* placements with `canPlaceCleanly`, so anything you were
  warned about was accepted by `placeFixture`, charged for, and then dropped on
  the re-flow that same call triggers. The refund came back in full, which is
  why it never read as an error — what you lost was the fixture and its stock,
  and what you saw was a shelf vanishing as you turned it. Rotation was the
  worst of it: `rotateFixture` deliberately settles for a warned facing when all
  three are warned, so a unit in a corner had no angle that could survive. The
  rule is that `canPlaceCleanly` belongs to callers building *unattended* — the
  generator furnishing its own loops, the balance bot — and never to a fixture
  somebody positioned by hand after being told what it would cost.
- **A variant is a look; a tier is a number.** Both are content on the same
  `fixtures` row, and the split is structural rather than a convention anyone
  has to remember: a variant carries only a `model`, while `tiers` is one
  ladder shared by every shape. So a corner shelf costs and holds exactly what
  a straight one does, restyling something already built is free and keeps its
  stock, and no shape anybody draws can move the balance or need `simulate`
  re-run. If a new shape *should* change what a fixture does — an island unit
  browsed from both sides, say — that is an anchor, which is behaviour, and it
  belongs in `shared/build.js` rather than in a variant.
- **Where goods sit is authored, not assumed.** A model part flagged
  `surface: true` is a shelf row, and stock is drawn on those boards, top row
  first, running along whichever horizontal axis the board is longer on. The
  axis is read rather than fixed because a corner unit's second wing runs the
  other way — assuming width is always z filed its stock into the wall. A model
  with no surfaces piles goods on its roof, which is what a chest freezer and a
  counter want. A part can also carry `alpha` for glass, which casts no shadow,
  and `drift`, which makes it leave whoever is holding it — rising, spreading
  and fading on a loop, for vapour and steam. Each is a flag one renderer knows
  how to read, and the pattern is deliberate: a new kind of behaviour on a part
  beats a second kind of model every time.
- **…and glass casts no shadow *unless it asks to*.** `shadow: true` on a part
  is that ask, and it only means anything on glass, because everything solid
  already casts. The rule it opts out of is right about what glass usually is —
  a door you look through, a bottle — and wrong about what a big flat *pane*
  usually is: fade a ceiling panel down far enough to see the aisle through it
  and the shadow it was laying on that aisle goes with it, so the fitting stops
  being in the room and reads as a decal on the camera. three.js has no
  half-shadow — the shadow map is a depth pass, so a part casts fully or not at
  all whatever its opacity — which makes this a choice between two wrong
  answers, and which is less wrong depends on how big the part is. `weld` groups
  by material, so two parts of the same colour AND alpha that disagree about it
  merge and take the first one's answer.
- **…and flagging a board doesn't make it one you can see into.** Goods fill
  from the TOP board down — right on an open unit, and exactly wrong on one
  that grew a canopy, because the covered board is then the one every unit of
  stock lands on. A tier-2 shelf sat 0.17 under a solid cap with its front row
  0.20 back from the lip, which at this camera pitch leaves *nothing* showing:
  a shelf holding four loaves drew four loaves and read as an empty shelf, so
  it presented as stock that never arrived rather than as art. Seven pieces had
  it, none of them visible in a screenshot of the one you happened to build.
  `drawableBoards` (`shared/model.js`) measures it off the art the way
  `surfacesAt` and `seamStep` do — `shown = headroom − setback × CAM_RISE`,
  ignoring glass and vapour — and the renderer stocks the boards that pass.
  It lives in `shared/` because `npm run docs:fixtures` is the other caller:
  the guard and the authoring reference disagreeing would be a lid the docs
  call fine and the game draws nothing under. A board covered by another
  *board* is left alone — that is shelving, and an L's wings overlap at the
  corner. The general trap: **a flag that says where something goes is not the
  same as a claim that you can see it there.**
- **A picture of a thing has to come from the thing.** The palette draws every
  entry from its own catalog row now (`client/thumb.js`) — which is the only way
  to tell five floors apart, since a floor *is* a look and the buttons were five
  names in one grey glyph. The trap is the half with no row: a wall is built by
  the renderer, so its button was hand-drawn to match, and the hand-drawn
  version was wrong twice over — a blue pane where the game glazes with the
  wall's own colour at a third opacity, posts and rails where the game builds a
  low solid slab. Neither would ever have been caught, because nobody holds a
  38px button up against a wall across the room. The shape lives in `edgeBands`
  in `palette.js` now and both callers ask for it. Anything that draws a second
  picture of something the game already draws has to derive it, not match it.
- **…and the mirror of it: some pieces do not read their row AT ALL.** A `lift`
  has a `fixtures` row with a model on it, a tier ladder, a price and a name,
  and the renderer never opens the model: the shaft is built in code from the
  `ELEVATOR_*` geometry in `scene.js`, wearing `CONVEYOR.*` out of `palette.js`.
  So authoring colour onto that row is a write that succeeds, a model that
  validates, a `content_version` that bumps, a client that reloads — and a
  shaft that does not move one shade. **Every signal says it worked.** An hour
  went into recolouring that row four different ways, and each round came back
  "still black", which reads as a caching bug or a stale tab rather than as art
  that was never asked for. The tell that would have ended it in a minute is
  that the drawn thing had features the row did not: the shaft on screen had
  rectangular windows and a bezel round its opening, and no part in the model
  was either. **When a piece will not change, grep the renderer for its kind
  before touching the row again** — `ELEVATOR_OWNERS` is right there and names
  three more. The general shape is the one `docs/fixtures.md` is generated to
  avoid: a catalog row is a *claim* about a piece, and only the code that draws
  it decides whether the claim is read.
- **…and a palette entry can be too dark for the INK to have anywhere to go.**
  `CONVEYOR.frame` was `#4e5865` on a good argument — a machine should key with
  the run it stands in, now that the pale deck has gone. That is a value
  decision, and it collided with a pass nobody re-checked: at 0.095 linear
  luminance a near-black contour has nothing to lay itself on, so the whole
  conveyor family drew with **no line on it** while the shelves and crates
  either side read perfectly. What that looks like from a chair is the ink
  working on two thirds of the shop, which reads as the pass being broken —
  and every hour of that hour was spent in `look.js` and `post.js`, where
  nothing was wrong. Structure is pale now (`frame`, `rail`, `track` all moved)
  and the dark is spent where it is small: `shadow` stays near-black, because a
  tunnel throat is a hole and a hole that is not dark is a decal. The rule the
  art has to hold, measured rather than felt: **a surface wants 0.20 linear
  luminance or more to carry a line, structure sits at 0.6–0.7, and dark is an
  accent on small parts.** A piece that is 50% dark by surface area is a piece
  the contour cannot describe. `INK.LIFT` exists for the genuinely near-black
  and is a rescue, not a substitute — it flips the line *lighter* than the
  surface, which is a highlight rather than an ink and will never key with the
  rest of the shop.
- **A person under the pointer is not the same as a person you pointed at.**
  A hire outranks the fixture behind them, and the argument is that they are a
  third of a tile wide and they move, so landing on one is deliberate. That is
  true of the pointer moving onto somebody and exactly false of somebody walking
  under a pointer that has not moved — which is most of what a shop floor does.
  What it costs is the *second* press: you open a shelf, reach back to press it
  again, a stocker has crossed in front of it in the meantime, and the press
  opens the stocker. Nothing on your side of the screen moved, so it does not
  read as a mis-click, it reads as the shelf refusing to open. `settledWho` is
  recorded on `pointermove` — the one event that is you rather than the world —
  and `aimPerson` is asked by the ring, the tap AND the hold, because a marker
  that lit up under a rule the press did not share is the green-ghost bug
  wearing a person. A finger is exempt and has to be: with no hover the press IS
  the arrival, and there is no "before" to have settled in. The general shape:
  **anything that decides what the pointer means has a second input nobody
  declared — the world moving underneath it.**
- **Aiming at a fixture is not the same as picking a tile.** A shelf is a
  three-quarter-tile-tall box, so on a 45° camera its top face is drawn most of
  a tile up-screen of the ground it stands on. `pickTile` answers "which floor
  tile" (for placing); `pickFixture` intersects each fixture height's top plane,
  tallest first, and answers "which thing am I pointing at". Using the first for
  the second selects the fixture *behind* the one you clicked.
- **…and hitting the right mesh is only half of it: a tile stopped being one
  fixture.** `pickFixtureHit` raycasts the art, which is right, and then threw
  the hit away and re-derived the answer from the tile it stood on
  (`fixtureAt`), which was right for exactly as long as a fixture stamped a
  tile. A decoration deliberately stamps none — that is what makes it weigh
  nothing — so a lamp hangs over a shelf and a plant stands at the end of a
  counter, and `fixtureAt` is a `find` over a list with `props` **last**. Every
  such prop was therefore unpointable: the ray hit the lamp, the answer came
  back as the shelf underneath it, and the ring, the menu and the bulldozer all
  named the wrong thing — which reads as "the pointer is selecting the tile
  instead of the prop", because it is. The group carries its own `f.id` now
  (`userData.fixture`, stamped where it is built, so it can never be older than
  the mesh) and the tile is the fallback for the groups that have none — a
  shelf's stock and a bed's crop, which belong to what they stand on. The
  general shape: **an invariant a lookup relies on can be retired by a feature
  three files away**, and "one fixture per tile" was retired the day a prop
  stopped owning its cell.
- **…and "the same fixture" is tile + kind + STOREY, spelled once.** An id is
  not durable — `repositionFixture` re-mints one on every turn, and the
  generator mints `shelf-p0`, `shelf-p1`… positionally and re-mints those on
  every re-flow, so an id lookup can quietly land on a different shelf. Tile and
  kind is the fallback every client-side holder of a reference used, and it was
  right for exactly as long as a square was one place. A duct over a belt
  matches on both. Three call sites had their own copy — the open menu following
  its fixture (`refreshFixture`), the teal selection following the same fixture
  with no menu up (`refollowSelection`), and a bulk pick's held refs (`liveRef`)
  — and all three re-pointed at whichever of the pair `fixturesIn` listed first.
  **What that reads as is the R key deselecting you.** Turn the duct; the
  re-flow moves the re-minted placement to the end of the list, so the selection
  lands on the FLOOR cell; the next press turns that instead; then it swaps
  back, forever. Nothing errors, both rotations happen, and the ring never
  visibly moves — so it reads as R picking at random rather than as a lookup
  missing an axis. `sameFixture` in `shared/build.js` is the one spelling, and
  it is in `shared/` rather than in `client/` because the answer has to be
  identical in all three or the ring is drawn round one fixture while the menu
  is open on another. `Scene.fixtureAt` takes an optional deck for the same
  reason; null still means "any", which is every caller that means a *tile*.
- **A colour that is right on a bar is not right on the number beside it.**
  `--good` and `--accent` are *mark* colours, measured against the panel, and on
  a 10px bar they are the correct green and red. The Shop report's warning tiles
  set 17px figures on a tinted ground, where the same two come out at 2.99:1 and
  3.14:1 — under the 4.5:1 a figure that size owes a reader — so they use
  stepped-down versions (`#a8442f`, which the heat pills already use, and
  `#8a5410`). The 34px hero is the opposite case and deliberately keeps the mark
  colours: over 18.66px bold the bar is 3:1 and they clear it. The trap is a
  later tidy-up that "unifies" the two back onto the variables, which looks like
  removing a magic number and is losing a contrast pass. The same pair is also
  the worst there is for a red-green colourblind reader — 2.3 ΔE, no separation
  at all — so **nothing in that panel rests on the colour**: the week's sign is
  which side of the axis a column is on, the hero says "profit" or "loss" in
  words, every delta carries an arrow, and each tile is labelled. Anything new
  in there has to keep that true.
- **`el.className = 'show'` silently deletes the `hud` class**, and with it
  `position: fixed`. The element drops out of the overlay into document flow,
  where you simply never see it. The toast had this from the beginning, which
  is why no error message has ever appeared on screen. Use
  `` `hud show${…}` `` or `classList`.
- **A fixture is priced by its catalog row, and only an appliance isn't.**
  `fixtureUnitCost` used to reverse-engineer a price by scanning upgrade payloads
  for whichever row sold that kind and dividing. That works only while every kind
  has such a row, which a planter never will. `cost` on the piece is the price
  now; `FALLBACK_FIXTURE_COST` is a *floor* for a kind nobody has drawn, not a
  second price list; and a prop authored at 0 is genuinely free, because a
  decoration is only ever its row. An appliance is still priced by its upgrade —
  that upgrade sells one machine, so it was never a division — and moving it onto
  the catalog is step 12 of docs/building.md.
- **A fixture upgrade grants nothing you can stand on.** `shelf-2`, `plot-3`,
  `checkout-2` and friends sell a *discount* on every one of that kind you build
  from then on. Best-of, never stacked, capped at `MAX_FIXTURE_DISCOUNT` — two
  multiplied discounts spiral toward free and the ladder is already ordered.
  `space` is the last upgrade that grants a thing, and the thing is land, which
  is why `buyUpgrade` re-flows the layout for `space` and nothing else.
- **Cheapest-first only works if you keep going when it fails.** The balance bot
  took the head of its spend queue on faith, and `buyUpgrade` refuses a whole
  class of row — so one refusal wedged it permanently: it bought a rucksack on
  day two and then nothing, ever, for the remaining fifty-eight days. Every
  balance number measured a shop that never hired and never grew, and nothing in
  the output said so. It walks the queue until something works now, and the
  numbers moved a lot when it did.
- **`generateLayout` is called from TWO places, and only one of them is the one
  you are looking at.** `Game.create` builds the first layout and
  `regenerateLayout` builds every one after it, and each spells the budget
  hand-off out by hand — `shelves: want.shelf, freezers: want.freezers, …`. So a
  new kind added to the first call site works perfectly until the next re-flow,
  which is the purchase itself: `compose`'s gate is
  `if (!(budget[p.kind] > 0)) shed(p)`, and a kind the second call site never
  mentions has a budget of 0, so it is built, charged for, and then dropped and
  **refunded** by the re-flow that same press triggers. Money back, so nothing
  looks stolen; what you see is the shop accepting something and then refusing
  it. `belt` shipped that way for about ten minutes and the tell was that
  `placeFixture` answered `{ok: true, placed: 'fx-18'}` while `layout.belts` was
  `[]`. The general shape is the one `Game.create`'s named-field payload already
  has: **out and back are two different pieces of code, and only one of them is
  obvious.**
- **A non-blocking fixture is refused a shared cell by its TILE, not by
  `blocked`.** `plot` has always been this and `belt` is the second. `canPlace`
  asks two questions — what the ground is made of, and whether anything stands on
  it — and a kind with `blocks: false` never answers the second, so the only
  thing stopping two of them on one square is that the first one's `ground` stamp
  is no longer in `BUILDABLE_INDOOR`/`BUILDABLE_OUTDOOR`. Which means a
  walk-over kind authored *without* a `ground` does not merely look wrong: you
  can stack an unlimited number of them on one cell, and `verify:catalog` is what
  catches it — every fixture must "either occupy its cell or be what the cell is
  made of", and that assertion is a deliberate invariant rather than an accident.
- **Only `ChannelHost` swallows a throwing message handler — Colyseus does
  not.** `verify:host` asserts that an unknown message type and a handler that
  throws are both survivable, and that claim is about the seam rather than about
  the game: the try/catch is in `server/rooms/host.js`, and the Colyseus base has
  none. So a bare identifier in a `Game` verb reached from one message is a
  *glitch* on the web build and a **dead process** on the desktop one — which is
  the exact divergence the seam exists to prevent, arriving as "it works on your
  machine". `buildRun` shipped referencing `CONVEYOR_KINDS` without importing it,
  and since every press of a conveyor tool goes through `build-run`, what it read
  as was the server dying when you place a loader. The lesson is the sweep, not
  the import: **a verb reached from exactly one message is a verb no sweep
  touches**, and `verify:*` drives `Game` directly.
- **A belt's only exit used to be a BOARD, so anything nothing wanted rode for
  ever.** Round a loop, or parked at a dead end where nothing can reach it, since
  the crew are told to leave a riding box alone — three frozen pizzas on a run
  with no freezer on it is a permanent passenger and the shop looks like it is
  working. A loader facing bare ground sets the rest of the box down on it
  (`armDrop`, through `dropGoods` like every other setdown), which is also the
  one thing `rot` decides on its own now that flow is derived. Three things keep
  it from burying the floor, and each is its own failure: it is reached only
  **after** every unit beside it has had its share, so a loader bolted to a shelf
  never prefers the ground; the mat **stacks to `ARM_DROP_STACK` and then stops**,
  because uncapped it is a tower for the rest of the save and a mat of one is a
  stockroom that holds a single box; and the pickup side **skips the faced tile**
  — three sides in, one side out, or the off-ramp is a loop that sets a box down
  and lifts it straight back up on the next swing.
- **A loader has no output, so flow has to be resolved for the whole layout at
  once.** `rot` on a loader is the shelf it unloads INTO — aiming it at the shelf
  must not break the run — so where a crate goes next is derived, and the
  derivation cannot be done cell by cell. Two shapes were shipped and both are
  wrong in ways that draw identically to a working belt. *Refusing to ask a
  neighbouring loader* (its answer is derived too, so asking is circular) is
  right for a loader with a belt on either side and wrong for every run MADE of
  loaders — which is what an aisle becomes once each cell stocks a shelf: nobody
  in a row of four has a feeder, nobody carries straight on, and the run bends
  wherever rotation order points. *Asking recursively with a guard set* is worse:
  "unknown" reads as "open", so the far end of a straight run resolves BACKWARDS
  and the two halves meet in the middle. `conveyorFlow` is the answer — flow has
  a source, every plain belt knows its own direction, so it is a walk FORWARD
  from the belts and a loader reached that way has a feeder. Three consequences
  worth keeping: **put belts on your corners**, because the last tie-break is
  "a plain belt over another loader" and a belt is the one of the two that
  carries information; a ring made entirely of loaders is degenerate by
  construction and falls back to a guess; and the result is cached against
  `L.belts`/`L.arms` by identity, so anything that *mutates* those arrays in
  place rather than re-flowing would hand out a stale map.
- **…and the unit is the LINE, never the tile — which is what four separate
  crate bugs turned out to be.** Crates skipped at a T, would not tween through a
  turn, appeared at the end of a segment, and reset to the start of a cell when a
  jam cleared. Each was fixed on its own and each fix exposed the next, because
  none of them was the bug: every cell owned a crate, a clock (`beltClock`), a
  reservation of the cell in front (`beltAim`) and its own answer to where that
  crate went next, so the code where two cells met was a **seam** — a creep to
  bank, a corner to special-case, a junction that asked a different question when
  its exits were full, and five different writers of `crate.x` that agreed
  everywhere except at the joins. A junction is where a crate changes which of
  those branches it is in, which is why a junction is where all four were
  reported. `conveyorLines` (`shared/build.js`) is Factorio's answer and this
  one: a line is a maximal chain with a path and a length, a crate on it has ONE
  number, the head advances if the exit will take it, everything behind is
  clamped `CRATE_PITCH` back, and `alongPath` derives the position. Four things
  about it are not obvious. A **loader does not break a line** even though it is
  a machine — it stands *in* the run, so breaking at machines turns a six-loader
  aisle back into six one-cell lines, which is the per-cell shape with a new
  spelling in exactly the shop belts exist for. The seam **overlaps**: a line's
  path runs to the first cell of the NEXT line, so the hand-off point is one both
  agree about and the box does not move when it changes hands — end it at its own
  last cell and there is a one-tile jump at every join, which is the skip rebuilt.
  The address is a **cell and not a distance** (`d.belt` + `d.off`), because a
  distance kept against a line is measured from somewhere else the moment
  somebody extends a run, and extending a run is a purchase, and a purchase
  re-flows. And a crate **must not count itself**: a ring is a line that feeds
  itself, so a box part way round the join sees its own committed hand-off as
  something in its way and waits for itself for ever — the one place the obvious
  code is silently a deadlock, and it draws as a conveyor that works until you
  close the loop. `CRATE_PITCH` was a whole cell for the same reason — the clamp
  is the only thing bounding what a run carries, so a tighter pitch silently
  doubles it. It is **0.5 now, and the doubling is paid for rather than
  silent**: `CRATES_PER_CELL` is `floor(1 / pitch)`, and `looseRoom` credits a
  conveyor cell that many boxes, so the pitch and the yard allowance move
  together. Change one and you have changed what the shop may order. The number
  itself is set by the CORNERS and not by the straights — round a right angle
  two crates either side of the vertex sit `pitch / sqrt(2)` apart, so 0.4 gives
  0.283 against a box 0.318 wide and they clip through each other, which reads
  as bad art rather than as arithmetic.
- **…and TWO boxes can be crossing into one line at once, which is a deadlock
  rather than a jam.** A crate that has left its own line and not yet arrived is
  counted against the line it is heading for, so a second feeder holds back —
  right, until both of them are part way in: each counts the other, `cap =
  Math.max(cap, at)` means neither may go back, and the pair stands there for
  the rest of the save with every line behind them backing up. Nothing errors,
  nothing spills, nothing is lost, and what you watch is thirty crates standing
  still on a conveyor that is working perfectly. A live shop had two rows and
  **38 boxes** wedged on one square with 67 in-game minutes going by and not one
  of them moving a pixel. `roomAt` is asked before anything crosses, so they
  should not both be able to commit — and a **re-flow** is what gets round it:
  the address is a cell plus an offset, `conveyorLines` re-cuts the shop on
  every purchase, and a box that was mid-LINE comes back mid-GAP. So `barrier`
  is a recovery rather than a guard now: among crates crossing into the same
  line, the one nearer to arriving wins and the rest are behind it rather than
  in its way. The general shape: **a reservation that only one party can hold is
  a deadlock the moment two of them can be handed it**, and the way in was not
  the code that hands it out.
- **…and a crate riding a belt is a STRAY as far as `unload` is concerned, which
  is a 1e6 bonus.** `stockCrates()` is deliberately the whole list — `homeSupply`
  counts a box on a conveyor as supply the shop already owns, `binOrphans` sweeps
  it, spoilage ages it, and every one of those is right about a crate wherever it
  is. A hire is the one reader for which it is not: `onAPad` is false for a box
  in transit, and `unload` scores `stray * 1e6 + moves`, so every stocker in the
  shop abandons the bay and beelines for whatever is going past. The belt would
  work perfectly and be emptied by the crew it exists to replace, and what you
  would watch is staff doing their jobs. `floorCrates()` is "a crate anybody may
  walk up to and lift" and the five job sites that LIFT ask it; everything that
  COUNTS goes on asking `stockCrates`. The general shape is the one `inACar`
  has: **a list whose membership used to imply a fact stops implying it the
  moment something can be in it for a new reason**, and none of the old readers
  looks wrong afterwards.
- **…and a belt runs PAST a shelf. Only a loader hands off, and the build ghost
  said otherwise for as long as there were belts.** `stepBelts` exits into
  conveyor cells and nothing else, so a run pointed straight at a shelf, a
  machine or a skip stops on its last cell with the box sitting on it — and
  `whatThisCosts` counted all three as a valid `flow.out`, which is the
  green-ghost rule inverted: the preview promising a join the sim has never had.
  Its cost was not one dead belt. A live shop fed both its skips off a *sorter*,
  so `conveyorMeets` answered "no bin on this network" from every cell, and
  `armSwing`'s guard — a loader may not lift rubbish unless there is a skip down
  the line, or the rot rides for ever — turned the whole feature off: 32 loaders,
  two paid-for skips, eleven crates of rot, and nothing anywhere saying a word.
  Two things fell out of fixing it, and both are the same shape as the bug. The
  run test named `L.belts` alone, so it fired on the commonest join in the shop
  (belt into loader) — a warning that goes off whatever you do is one nobody
  reads, which is what made the real one worthless. And the loader's own
  "nothing beside it to fill" named only `L.shelves`, so the one press that
  fixes this — a loader put next to the skip — was told it had nothing to do.
  **A warning is only worth what its silence is worth.**
- **…and a loader emptying into a UNIT hands on to nobody, which is a flow
  answer rather than a missing one.** `conveyorFlow`'s last pass resolves
  whatever the forward walk never reached, and it made every such cell guess a
  next cell — so a loader with a skip on one side and a sorter on the other came
  back as pointing AT the sorter. `conveyorBranches` drops any neighbour whose
  flow points back (a two-cell tug of war), so the loader was refused as a way
  out: no blade drawn, no light on that side, nothing ever sent down it. Which
  is exactly the build the skip exists for, reading as a junction that cannot
  see a machine bolted to its own side — and the loader is aimed correctly the
  whole time, so the one thing on screen you would check says it is fine. A live
  shop had **1 of 91** conveyor cells able to reach a skip it had paid for. The
  fix is that a loader whose `rot` names a shelf, a machine or a skip answers
  `null`: it is a terminus, what arrives goes into the unit, and there is no
  next cell to name. Only the walk's leftovers are answered that way — a loader
  with a feeder was resolved above and is part of a run whatever it pours into —
  and the pair that keeps it honest is that a loader aimed INTO the junction is
  still refused, because that one really is declared to feed it. The general
  shape: **a derivation with no answer must be allowed to say so**, or the
  guess it makes up gets read by everything downstream as a fact somebody
  stated.
- **…and a crate may not REST on the rails, which is a rule and not a plea.**
  The square being part of a run and the box being ON the run are two claims,
  and a box could satisfy the first without the second for as long as there have
  been belts. Rot is how it happens without anybody asking: `dropWaste` puts it
  down where the food was, and in a shop with a line down the aisle that is a
  conveyor cell. Nothing then owns it — `stepBelts` moves what has `d.belt`,
  `armDrop` refuses to put anything on a rail, and a loader's side scan is about
  the floor — so it stands there with goods gliding through it, untouchable by
  every machine in the building, looking exactly like a belt that refused it.
  Four crates on one live save. `clearRails` runs at the top of the belt pass
  and is both halves or neither: what may ride goes ON (a run you built is a
  thing that takes goods somewhere) and what may not is moved CLEAR, which is
  what keeps a box of rot from being lifted onto a network with no skip on it
  and jamming the run for the rest of the save. `mayRide` is the one spelling of
  that second question, asked here and by the loader's own lift — the two
  disagreeing is how the asymmetry bug got in the first time. Fixing it at the
  SOURCE is the road not taken and worth saying: `dropGoods` and `dropWaste`
  could each refuse a rail, which is two guards that do not cover a save that
  already has boxes on one, and no guard at all against the next thing that
  learns to put goods down.
- **…and UP is a way out, which is one function that must never be folded into
  the four-way loop.** `stepFrom` is the same-deck rule and it is what a second
  storey IS — leave the deck out of it and a duct laid over a run merges with it
  silently, boxes changing storey at every crossing, drawn as a conveyor that
  teleports and read as one that works. So `acrossFrom` (the same square, the
  other deck) is its own function and every place that enumerates ways out asks
  for it **by name**, which is what keeps the list of askers short enough to
  argue about. Two ask. A **junction**, and that is not a special case: you do
  not aim a branch today either — `conveyorBranches` takes every neighbour that
  is not the straight-on and is not feeding it, and `rot` only ever decided which
  goes first. And a **loader with nowhere else**, which is `choose`'s last resort
  and is the whole opt-in: a loader mid-aisle with a duct crossing over it
  carries straight on exactly as it always did, so the only machine that ever
  looks up is one that has run out of shop. Three things about the rest of it.
  `throughR` is never asked of a rise and must not be — a cell carrying on
  straight up because the cell below is a conveyor is a *column*, not a line.
  A **lift** is excluded at both ends, because its own square on the far deck is
  itself and "straight up" would be a cell whose next is its own id, which is
  `liftTo`'s guard one storey along. And the **feeder test** is the vertical's
  copy of `feedsUs`: without it the floor cell hands up, the ceiling cell hands
  down, both on the same square, for ever — the loader ping-pong `conveyorFlow`
  already warns about stood on its end, and it neither errors nor spills. What it
  cost in the sim is `armSwing`'s off-ramp moving to the TERMINUS. It began as a
  rung above the ground drop and below the units — below the drop it would be
  dead code in every shop, since the endcap it exists for has walkable floor
  beside it and so does every other loader ever built — and that was still not
  enough, which took a screenshot to see. Preferring the rise only holds the
  loader whose OWN next cell is the duct, so every loader upstream of it still
  had a horizontal way on, and the first one with a full board and a walkable
  tile beside it emptied the box onto the floor long before it ever reached the
  return leg. Every box that came off was one a shelf genuinely refused, so the
  machine reads as working the whole time. So: *a loader only puts a box down
  when the run has run out.* Step 2's reason for the off-ramp is still right — a
  crate nothing wants must not ride for ever — but a dead end stopped being the
  only shape a run comes in, and a full loop circulating IS what a loop is: the
  boxes going round are the buffer and the one signal the shop is backed up.
  Every dead end keeps its exit, a skip still takes what nothing wants, and a
  junction still has `sorterEject`. `verify:belts` §16b is the pair to §16 and
  the two of them are the whole rule. What it cost in geometry is nothing at all — `beltExit`'s
  hop already charges a deck change, and a rise is a leg with `flat === 0`, so
  `conveyorLines`' riser branch is skipped and `alongPath` already carries the
  box straight up over its own square.
- **…and a shaft can be TOLD, which is the one thing the derivation cannot get
  right.** Reading a lift's direction off its feeder beats any setting until two
  runs arrive on the same square — the ordinary way two levels of one loop
  rejoin — where there is nothing to derive and `liftTo` takes the floor's
  arbitrarily. `way` (`null`/`up`/`down`) is a field on the placement,
  deliberately not `rot` — up and down are not quarter turns, and `rot` is
  spoken for one axis over (see the next entry). `null` is every shaft ever
  built. The **pass-through comes free
  and is not a fourth setting** — a shaft told Down hands to a floor cell beside
  it, so a crate that arrived along the floor carries straight on into it while
  one that arrived overhead descends into the same cell. The one thing it needs
  that `auto` and `reject` do not is that the press **re-flows**: a sorter's
  `auto` is read by `sorterOut` when a crate arrives, so mutating it in place is
  honest, where `way` is read inside `conveyorFlow` — cached against its four
  arrays by identity — so mutating in place hands every reader the map from
  before you pressed the button until somebody builds something. A setting that
  takes effect next Tuesday reads as a button that does nothing.
- **…and a shaft's `rot` is WHICH SIDE IT LANDS ON, which is the loader's
  meaning of the key rather than the belt's.** `way` answers the storey and says
  nothing about the square, and a shaft has up to four ways out on the deck it
  arrives at — so `liftOut` took the first in enum order, and which cell a
  descending crate carried on into was decided by the numbering of `[0,1,2,3]`.
  A lift landing beside a belt to its east and a tunnel mouth to its north
  always chose the belt, and the north leg could not be built at all: the only
  way round was to demolish the neighbour that kept winning. It is invisible,
  because a shaft that chose the wrong exit and one whose other leg has not been
  built yet are the same still frame — every box arrives correctly, down a leg
  that works, and the run you meant never carries a thing. Two things keep it
  cheap. It is a **preference and never a pin**: an aim at a wall, at its own
  feeder or at nothing falls through to the scan it always used, or one press of
  R turns a working loop into a terminus. And `rot` defaults to **0**, which is
  the side the scan already tried first, so no shaft in any save moves. The trap
  on the way in is this file's own, twice over: `makeLift` wrote `rot: 0` as a
  **literal**, and `compose` rebuilds every record from its placement — so the
  press could not have moved it however rotatable `BUILD_KINDS` said the piece
  was, and what that reads as is an R key that does nothing on one kind.
- **…and a lift's `deck` is a fact about the PLACEMENT, so asking the cell what
  storey a box on it is on gets the floor every time.** It reads 0 whichever end
  of the shaft you mean, and that is the right answer for both real rides — going
  up the box starts on the floor, going down it ends there — so a path that puts
  the shaft's own point on the floor is telling the truth about half of each and
  the riser covers the other half. The **pass-through** is the case with no floor
  half at all: a shaft told `up` hands to a cell beside it on the CEILING, so a
  duct arriving overhead crosses its square (which is what `setLiftWay` means by
  the pass-through costing nothing), and the drawn path dived four metres and
  climbed straight back for it. What that reads as is a lift snatching a box off
  the rail, taking it to a storey with nothing on it, and throwing it back up —
  the shape of a routing bug, with the routing right the whole time. So a LINE
  carries the answer (`line.decks`, `conveyorLines`) and every reader that asks a
  line what storey one of its cells is on asks that instead: the seam
  (`beltExit`, which charges the rise as a tile of the hop), the exit polyline,
  the two descent gates, and the flow overlay's `hop`. It moves the
  pass-through and **nothing else** — an ascent, a descent and a shaft with no
  exit at all are `deckOf` to the byte, deliberately, because `wholeLegs` and the
  shaft's approach caps are choreographed off exactly those distances.
- **…and the platform's way HOME was the one stroke nothing scheduled.** Every
  other move a carrier makes has a clock — a pickup off `shaftGrantAt`, a loaded
  ride off `shaftCarryUntil`, the empty drop after a box has risen off
  `shaftBusyUntil` — and coming down from the top with nothing left to do was the
  *fall-through*: `commitEndpoint(id, 0)`, so the client is simply told it is
  down and it arrives there in one frame. It survived because the case it shows
  in did not exist. A shaft that carries a box up schedules its own drop on the
  tick the box lands, so the fall-through only ever caught a platform left at the
  top by something that did NOT ride it — which is exactly what a pass-through
  is, since the piston still rises to give the box something to cross ON. A
  grant is answered **above** the new stroke, which is what keeps a busy duct
  from twitching its lift down between boxes.
- **…and a ROOF is a fact about the walls, which is `canKeep`'s bug rebuilt one
  storey up.** That function exists because `where` is not a fact about a shelf:
  knock a hole in your wall, un-enclose the building, and every fixture reads as
  outdoors and is shed. The ceiling branch of `canPlace` skips everything about
  the floor and keeps two rules, and both were written as though they were facts
  about the duct. The roof is not one. Enclosure is shop-wide and
  **all-or-nothing** — take enough of a wall out and `computeIndoor` answers
  *zero* indoor cells rather than fewer — so one accidental delete failed "there
  is no roof there" for every overhead cell in the building at once and `compose`
  shed the lot. Refunded in full, so nothing is missing and nothing is logged;
  what you lose is the build, and what you see is your entire ceiling gone for a
  gesture the game called a warning. It is a **keeping** rule now (`!keeping`),
  narrowed rather than deleted — you still cannot lay one under open sky. The
  general shape, and it is this file's third time: **a rule phrased against
  enclosure has a silent third state, and it is not "a bit less room", it is the
  rule applying nowhere.** Worth asking of every test that survives a skip: is
  this a fact about the thing, or about the shop around it?
- **`repositionFixture` NAMES every field it keeps, so a setting left out is
  reset rather than merely not copied.** It builds a fresh placement — `boh`,
  `piece`, `tier`, `variant` — and then re-flows, and the re-flow rebuilds the
  record from that placement. So a field it forgets is handed back its default
  by the same call. It is `Game.create`'s named-field trap in the one place a
  *player press* runs it: the press is **R**. Turning a loader to aim it at the
  line you want gave the machine its pickup back; turning a sorter switched the
  crew back on and forgot where strays went. All three look exactly like the
  button not working, because the turn you asked for did happen — and the
  setting you cannot see resets under it. `sorter.auto` had it from the day it
  shipped and nothing caught it, because every sweep tested a re-flow
  (`regenerateLayout`) and a re-flow is not a reposition. The fields ride as
  `undefined` rather than as defaults, or this file and `server/layout.js` each
  own half of what a new piece does.
- **`ignoreId` is "what is in the air", and it stopped being ONE thing.** It was
  a single id for as long as only one fixture could be moving, which was true
  until Move learned about a selection — and the old spelling fails in the most
  convincing way there is: a whole aisle shifted one square along has each member
  refused for standing in the way of the neighbour it is about to replace, so six
  perfectly legal placements come back as six noes and nothing anywhere says the
  rule being broken is one about a batch. It takes a `Set` too, and every one of
  the eight places that wrote `f.id === ignoreId` asks `ignores(ignoreId, f.id)`
  instead. That it is a function rather than a widened comparison at each site is
  the point: a site that kept the `===` works for a selection of one and quietly
  answers "no" for the case the change exists for. Three callers pass a set —
  `shiftFixtures`, the undo walk (`movingIds`, which forgives only the parts that
  actually change tile, since a part standing still is not leaving) and the
  client's own shift preview, which has to agree or the ghost is amber over a
  press the shop accepts.
- **Fixture ids live in two namespaces.** The generator mints `shelf-p0`,
  `till-p0`…; anything the player positioned keeps an `fx-N` id. They must never
  collide, or a re-flow hands a shelf someone else's stock.
- **Props live in `actorRoot`; the layout lives in `staticRoot`.** `buildWorld`
  rebuilds the second and must explicitly tear down the first. Clearing the
  `shelfProps`/`plotProps` maps without removing the meshes orphans every stack
  in the scene at the *old* shelf positions — which reads in-game as stock
  scattered across the floor, and leaks another full set on every re-flow.
  Positions are also re-read every sync, not just at creation, so a fixture you
  move takes its stock with it.
- **A readout belongs to the SPOT, not to the thing that landed on it.** Money
  drops carried their own `+$4.20`, which is right for one sale and wrong for
  four: the server fans successive piles across a third of a tile so they read
  as several piles, and from this camera that stacks four labels into a column
  of arithmetic over a till — four numbers answering a question nobody asked,
  when the only one anybody has is *how much is on that counter*. The piles stay
  several and the number is one per tile, which is the call `buildPallet`
  already makes about a stack of crates. Two things fell out of it. A label
  keyed to a drop leaves when that drop is picked up, with money still sitting
  there — so it is keyed by tile. And a sprite owns a canvas, a texture and a
  material that **`disposeGroup` was not freeing** (it looks for `isMesh`), so a
  label rebuilt every time its number moved leaks all three on every sale;
  `setTextSprite` repaints in place, and `disposeGroup` now frees sprites too,
  which quietly fixes the same leak for every crate label in the game.
- **The build ghost and the server share one validator.** `shared/build.js`.
  Reimplementing the rules client-side to keep the preview snappy is how a
  green ghost starts promising placements the server then refuses.
- **The director's "already ran today" guard has to survive a *cold* restart,
  not just a hot one.** It lives on the save as `lastDirectorDay`, claimed
  synchronously at the top of `runDirector` — before the API-key check, because
  the no-key fallback still writes an event and a guard set after that check
  never fires for anyone without a key. It used to be a room field carried
  through `onCacheRoom`, which survives a devMode reload and nothing else: every
  cold start fired another world event onto the same day, and a day of active
  editing left six copies of one heat wave in the table. Cheap to miss, because
  the sim looks fine — `foldModifiers` collapses same-event rows to their
  strongest pull, so the *balance* never moved. All you see is a HUD wearing
  twenty-six chips, which reads as a mad world rather than as a bug.
- **`world()` handed out DEFAULT_WORLD's own arrays.** The loader spread
  `{ ...DEFAULT_WORLD, ...saved }`, which is shallow — so a world with *no*
  save (an ephemeral balance run, a verify sweep, a slot nobody has opened)
  got the module-level `ownedUpgrades` array itself, and `buyUpgrade` pushes
  onto it. One `simulate` call left the default owning twelve upgrades for the
  rest of the process: the next run started rich, the next richer, and ten
  seeds "averaged" a shop that grew between every seed. Nothing in the output
  says so except `startedWith`, which is the only reason it was ever caught —
  check it, it is there for this. `structuredClone` now, and the same trap is
  waiting for any mutable field added to `DEFAULT_WORLD`.
- **devMode never cached a thing, so `persist()` is the whole of what survives a
  restart.** `onCacheRoom`/`onRestoreRoom` in `MartRoom` read as a safety net for
  everything `persist()` doesn't write — crates on the bay, cash on the counter,
  where everyone is standing, what is in your hands — and that net has never once
  been there. Two independent reasons, both invisible. `server/index.js`
  registered its *own* SIGINT/SIGTERM beside the one Colyseus already registers,
  and the loser of that race gets `already_shutting_down`, which
  `gracefullyShutdown` catches and then follows with `process.exit(0)` — killing
  the process before `presence.shutdown()` writes `.devmode.json`. And even with
  that gone, Colyseus 0.16.5 disposes every room (which deletes it from the
  `rooms` map) *before* calling `cacheRoomHistory(rooms)`, so `onCacheRoom` is
  asked of nothing. The room id still restores, which is what lets the browser
  reconnect rather than fail eight times — but **anything that must survive a
  reload has to be in `persist()`**, and the `elapsed` trap applies to every
  clock you put there (`bornAt`, `plantedAt`, `yieldedAt`, `arrivesAt`). The
  general shape: a fallback nobody has watched work is a fallback that isn't
  there, and this one hid behind a save that restored the shop perfectly.
- **A room being OPEN and a world RUNNING are two different things, and one
  timer used to answer both.** An empty room kept stepping for the whole idle
  grace — five real minutes, which is most of an in-game trading day and more
  across the night at `NIGHT_SPEED`. What runs in those minutes is a shop that
  is open with nobody on the till, so every shopper queues and storms out at
  −0.03: **34 of those is the entire range of reputation**, so closing the tab
  for tea and coming back to a shop the town has turned on was the reliable
  outcome rather than an edge case. It is invisible in the only place that would
  say — the ledger blames "Lost patience", which is exactly what happened and
  says nothing about nobody having been there. `stepIfWatched` splits the two:
  the room still lives five minutes so an agent's headless call has something to
  land on, and the world inside it is frozen for all of them. It is deliberately
  **not `Game.paused`** — that is a fact about a person, it persists as a stamp
  and strikes the clock through, and a shop coming back stopped because it once
  sat empty is `pausedAt` firing for a reason nobody chose. And it lives in
  `ShopRoom` rather than in either Base, which is what makes the desktop and web
  builds unable to disagree about when the world runs — see the seam in
  `server/rooms/host.js`. The general shape: **a grace period for one resource
  is not a grace period for every resource that happens to share its timer.**
- **A seam with one implementation is a seam that compiles, and the thing it
  forgets is the case the one implementation cannot have.** A channel is
  `{post, onFrame, close}` because the first one was a Worker port, and a worker
  port cannot go away on its own — the thread dies with the page, and the page
  taking the shop with it is already handled. A peer *can* go away on its own,
  and nothing in the shape said so, so for the whole of step 6 no code anywhere
  detected a dropped connection. Three failures, none of which look like a
  networking bug: a guest who closed their tab was **still standing in the shop**
  holding stock nothing could get back (`onLeave` is what runs `removePlayer`,
  and nothing called it), the room went on broadcasting at a dead wire with
  `emptySince` never starting, and a guest whose host closed *their* tab was
  looking at a photograph — a shop that stopped, with nothing on screen to say
  why. `onClose` is the fourth method; `dc.close` and the connection reaching
  `failed` are two different deaths (a tab, and a laptop lid); `disconnected` is
  deliberately not one of them, being transient by definition — treating it as
  death throws somebody out of a shop over a lift. The general shape: **when a
  second implementation of a seam arrives, the question is not "does it answer
  the calls" but "what can happen to it that could not happen to the first".**
- **A `sessionId` is per connection, so leaving used to destroy what you held.**
  `removePlayer` deleted the whole person, `carry` included — a devMode restart,
  a closed tab or four seconds of bad wifi binned an armful of paid-for stock
  with nothing logged. It drops as a crate now (`dropGoods`, the fifth caller),
  which `verify:build` asserts as conservation. Staff are the opposite case and
  worth the contrast: `staff-<n>` outlives the socket, so they *are* saved, spot
  and hands both.
- **…so YOU got an id that outlives the socket, and the drop became the
  fallback.** `who` is minted once into the browser's localStorage
  (`whoAmI`, client/net.js) and sent as a join option; `Game.away` keys where you
  stood and what you held on it, rides in the save beside `staffAt`, and
  `addPlayer` puts you back. No reconnection window, on purpose: a window is
  about a socket and holds a live object open for thirty seconds, where what was
  wanted is about a *save* — a `node --watch` restart, a closed tab, tomorrow.
  Four things about it. The record is **consumed on the way in**, because two
  tabs are one `who` and a row still sitting there is a second armful of the same
  six loaves; **overwriting** one drops what the old row held, which is the one
  case the crate on the floor is still right for; `saveState` writes rows for
  people who are still **connected**, since the usual way this shop goes down is
  a restart under somebody who never left and `removePlayer` never runs on that
  path; and a remembered spot is **offered, never trusted** (`canStand`) —
  hands come back regardless, because a wall can invalidate where you stood and
  not what you were holding. Somebody with no stable id (private mode, a sweep)
  gets the old behaviour exactly, which is why `verify:build`'s conservation case
  still passes unchanged.
- **Copying `data/game.db` with `cp` silently copies a stale shop.** SQLite is
  in WAL mode, so recent writes live in `game.db-wal` until a checkpoint. `cp`
  of the `.db` alone loses them, and the worlds you were about to measure may
  simply not be in the copy — at which point `world()` falls through to the
  starter shop and you spend an hour comparing two default worlds while
  believing you are measuring somebody's real one. `VACUUM INTO` a consistent
  copy instead.
- **A layout re-flow used to restart shoppers who had already paid.** Every
  customer was reset to `BROWSE`, including ones in `LEAVE` walking out with an
  emptied basket — so they turned round, found they wanted nothing, and were
  booked as having left empty-handed at −0.015 reputation each. A player who is
  *building* re-flows constantly, so reputation floored, `pull` floored with it,
  and the shop stopped getting customers as a direct consequence of having
  served some. `LEAVE` now survives a re-flow. Anything that resets customers
  wholesale needs to ask which of them were already finished.
- **One seed is not a measurement.** `clear_modifiers` is necessary and not
  sufficient. The bot picks crops by weighted random draw, so a change that
  calls that draw a different number of times shifts the whole RNG stream and
  the two runs diverge for reasons that have nothing to do with what you
  changed. Auto-replant measured −14% on one seed and **+7.8% averaged over
  ten** — 6/10 seeds went the other way, and one swung 900% because the
  baseline nearly went broke. Average across seeds before believing anything,
  and be suspicious of a single number either way.
- **…and in a shared world, `clear_modifiers` + one seed is not even a
  *control*.** `simulate` builds its throwaway game from the **saved** world, so
  every restart picks up whatever the other person has done since. Appending a
  comment to `staff.js` — a no-op restart, no behaviour change of any kind —
  measured 41,523 / 43,464 / 41,566 against 42,873 / 41,927 / 41,433 on three
  seeds: up on one, down on two, and `startedWith` identical on all six runs. A
  change you are actually testing will hide inside that. The fix is to take the
  world out of it: `DB_PATH` honours **`SNS_DB`**, so copy `data/game.db` once
  and drive `simulate` in-process against the copy. No server, no restart, no
  other player, and both halves run against one frozen world — which is how a
  rendering change can honestly claim "identical to the cent".
- **…which is also why everybody's NAME comes off a stream of its own.**
  `server/sim/names.js` — two registers, machines for the hires (a worker is
  drawn with a chassis, trim and a glow, so "Marla Finch" is a picture and a
  name disagreeing) and mostly people for the shoppers. `Game.namer` is seeded
  once in the constructor and **never re-seeded**, which is two claims rather
  than one. It is not `this.rng`, because that one is re-seeded `seed:day` and
  every balance number in the game is downstream of how many times it has been
  called — naming a shopper out of it would move every basket, crop and spawn
  roll after it, and two `simulate` runs either side of a word list would
  diverge with nothing to say why. And it is not re-seeded at the day roll,
  because a namer restarted each morning hands out Monday's names again. If you
  add anything else that wants a name, take it from the namer; if you find
  yourself wanting a random *look* or a random *position*, that is the sim's rng
  and it belongs in the measured stream.
- **A convenience that spends money needs to spend it on what you asked for.**
  Harvest replants the bed with the seed you have *selected*, not the crop it
  just picked. Those look equivalent and aren't: replanting the old crop
  charges for a seed you were about to replace, so every switch buys two. It
  cost a third of all profit and no playthrough would ever show you why.
- **A check that looks like "don't buy what you already have" may be about
  something else entirely.** `restock` opened with "is there a pallet at the bay
  I could unload instead", which reads as a supply test and is a *scheduling*
  one: it says what to do this tick and nothing about how much to order. So a
  shelf reserved for carrot and stripped into crates two tiles away read as bare
  and bought a full unit, and a shop with four beds of carrots bought carrots at
  wholesale for ever — the farm competing with itself, which presents as the
  farm being pointless rather than as the ordering being wrong. `homeSupply` is
  the real test now (crates, hands, and beds scaled by how grown they are), and
  it has to bound the *choice* as well as the amount or a shelf kept for two
  things orders the one already on its way in. See docs/ordering.md, which also
  covers the three switches in the supplier — and note that `assign` gates the
  shop choosing your *range*, never a stocker putting away goods you have
  already paid for.
- **The shop stopped buying what it already had, and went on *making* it for
  ever.** `restock` has asked "have I got somewhere to put this" since step 1 of
  docs/ordering.md; the two jobs that produce goods — `craft` and `harvest` —
  never asked at all, and `dropGoods` shares a cell rather than refusing once a
  pad is full, so the pile grew upwards with nothing anywhere to say stop. Both
  loops close through the drop-off: the kitchen emptied a full tray *because* it
  was stopping the machine, which is what let the next batch start, and picking
  a bed is what frees it to grow the next one. A shop with every board committed
  therefore produced indefinitely, and it reads as a stocker who has quit rather
  than as a farm that will not stop picking. The fix is one question asked
  before producing — and **buying and producing are not the same question**,
  which is the half worth remembering. Gating the farm the way the kitchen is
  gated (a free board, or don't pick) measured **−9.3% mean profit over ten
  seeds**, two of them down a third: a crate of bought stock with nowhere to go
  is money already spent, but a crate of your own eggs cost nothing and is a
  *buffer* — a stocker shelves it the moment a board frees and the bed is back
  in production behind it. So `hasHome` (a shelf, and no crate of it already
  waiting) gates the kitchen, and `hasSomewhere` (a shelf, or room on the pad)
  gates the farm, which is `bayRoom`'s promise said about the drop-off: how big
  you painted it is how much the shop will make. Measured identical to the cent
  over ten seeds. `simulate` cannot see the kitchen half at all — the balance
  bot never runs an appliance, so "no change" there is the instrument being
  blind, not the change being free.
- **A job that puts something down is not finished until nothing picks it back
  up.** The `merchandise` job clears a board nothing has sold onto the drop-off,
  and the crate it makes is an ordinary pallet — there is only one kind. So
  `unload` lifted it, `shelve` filled the board it had just come off, and a
  minute later the shop was exactly as it started, four days from doing it
  again. The whole job was a loop that moved stock around and changed nothing,
  and it would never have read as a bug, because a hire crossing the floor with
  an armful is what a working shop looks like. `giveUpBoard` marks the **item**
  — on `orders.dropped`, read by `shelvesFor` and `pickItem` — and marking the
  *board* would have been the same bug one delivery later, on the unit next
  door. It deliberately does not expire: the crate is still on the pad, so a
  timer just restarts the round trip on the day it lapses. Your own hands never
  read it (`stockShelf` is untouched) and ticking a shelf for it clears it
  outright, which is the same line `orders.assign` draws — the shop's judgement
  about its own range was never a rule about what you may do.
- **…and the same loop was running with YOUR hands in it, for four steps.** Clear
  a board or tip a unit out and the goods land in an ordinary pallet beside a
  board that is now bare *and* unlabelled — which is the best shelf in the
  building as far as `shelvesFor` is concerned — so the next stocker past put it
  straight back. What that reads as is the button not working, and the shop looks
  busy while it undoes you. `clearBoard` and `stripShelf` set the same mark the
  hand does now (`dropItem`), with the same two ways out. Three things decide
  where it does NOT apply, and each is a sentence rather than a rule: taking an
  armful (`unshelve`) or pulling a board into a crate (`crateBoard`) both keep the
  label, and a stocker refilling a board the shelf still remembers is *correct*;
  `stillStocked` spares an item another board is holding or set aside for, or
  consolidating two boards into one retires what is on them and strands the
  crate; and a strip keeps `assigned`, so a shelf you ticked for cheese is
  refilled with cheese and only the boards you never spoke for are let go. The
  general shape is the one above wearing the other pair of hands: **a loop closed
  for the job that spawned it is still open for every other caller of the same
  verbs.**
- **…and for two steps only HALF the shop knew it had given up.** The mark is on
  the item (`orders.dropped`) and `shelvesFor` opens by refusing a dropped item
  any shelf at all — larder or floor — which is `giveUpBoard` doing its job. The
  *buying* half was never told. `pickItem` checks it, so a BARE board was safe,
  and that is exactly why it survived: the hole is the **top-up** path, which
  picks the emptiest pile already standing on the unit, and a given-up item is
  still standing on every other board it was on. So the vans kept coming, and
  every case landed somewhere nothing could ever shelve from. It is a one-way
  pile, and **not one symptom appears where the bug is**: the yard fills, so
  `bayRoom` collapses and the shop quietly stops ordering what it *does* sell,
  and `putDown` cannot stow onto a full pad — which is its documented promise to
  hold goods rather than bin them — so the crew stand about with full arms. What
  you watch is a shop whose staff have stopped working, four days downstream of
  a purchase order. Found on a live save at day 97: six items given up over days
  94–95, the next morning's log ordering 9x Dried Pasta, 25x Liquorice and a
  Breakfast Cereal against all six, and the stranded pile going 33 units → 59 in
  one day. `givenUp` is the one spelling now and BOTH spending paths ask it —
  `buy` and `larderOrder`, because an ingredient strands exactly as a product
  does. A reservation overrules it (`keptFor`, shop-wide) or the shop refuses to
  buy for a board it would happily shelve. It does **not** clear the mark the
  way `shelvesFor` does: that function is placing goods that already exist, this
  one is deciding whether to create any, and one writer of `orders.dropped` is
  the point. The general shape, and it is the third time in this list: **a rule
  the shop enforces when PLACING goods has to be asked again when BUYING them,
  and the two are different files.**
- **A guard that names ONE job answers a different question than it looks like.**
  The line in `stepStaff` that ends a half-done errand read
  `!jobs.some((j) => j.job === 'merchandise')` — which does not say "can anybody
  finish this", it says "is this the one job that had errands when I was
  written". So the second two-leg job (`ferry`) set `s.shifting` and the very
  next tick wiped it, and the hire stood holding six loaves for ever: precisely
  the bug that line exists to prevent, caused by the line itself, and it looks
  identical to a pathing fault. `SHIFTERS` is the set now. The shape to watch
  for: **a predicate written against the only member of a category is a
  predicate that silently excludes the second one**, and it fails in whichever
  file adds that member rather than in the file that is wrong.
- **…and a spill TOPS UP a board, it never opens one.** `homeFull` waives the
  one-home rule when the home has no room left, so goods already paid for are
  not stranded behind a full unit — and "any other legal unit" is the spread bug
  wearing the waiver's clothes the moment anything PRODUCES. A farm is exactly
  that: four beds of carrots fill the home, overflow onto a bare board, and each
  board it claims is one the range never gets, so the shop quietly becomes three
  shelves of carrots and stops widening. Every step is a worker correctly
  shelving goods, which is why it reads as the crew being stupid. So the waiver
  needs `shelfStack(sh, itemId)` as well: stock may go where that stock already
  lives (which still settles, since `homeShelves` keeps the fullest unit the
  home and `releaseBoards` takes the drained one back), and surplus with a full
  home and nowhere it has ever been waits in its crate — the honest signal that
  the shop wants another unit. `verify:hand` pins both halves, because "nothing
  stranded in the yard" and "no board opened" are each other's failure mode.
- **…and the chevrons answer for EVERY pile in your hands, not the biggest.**
  `takers` took `lotMain`, on the argument that lighting every unit that would
  take any of three kinds is a shop with a light on every fixture — which is a
  claim about a shop, where the marker is a promise about a PRESS, and one press
  pours every pile that fits (`pourInto`). Hands holding bread and ice cream are
  two answers and the freezers are half of them: the shelves lit for the bread,
  no freezer lit at all, and the ice cream went into one perfectly well when you
  tried it. That is the green-ghost rule inverted — a unit that takes a press it
  never advertised — and it is the same disagreement `shelfAccepts` exists to
  close. The dilution is bounded by `LOT_KINDS` and by the rule itself: a unit
  still has to be the right kind, unreserved, and have a board with room.
- **…and a reservation decides which boards may be OPENED, not what may be put
  on one that is already standing.** `assignShelf` deliberately leaves stock
  alone when you tick a unit for something else — "the goods stay and sell down"
  — so one press puts a unit into a state where a board carries an item's name,
  its price and its capacity while `boardFor` refuses that item and names a
  different one in the refusal. A live freezer showed `Frozen Pizza 0/8` above
  `Fizzy Soda 0/24`, said *2 of 2 in use*, and turned away an armful of frozen
  pizza. There is no way to read that except as the shop being wrong about its
  own shelf, and the empty case is the sharp one: nothing left to sell down, a
  board spent on a label, and `releaseBoards` two quiet days away from noticing.
  So the reservation is asked with `byHand` and a board that already stands is
  exempt. **The split is the point** — the shop's own choosing (`shelvesFor`, and
  `restockQueue` behind it) stays strict, or a leftover board becomes a home
  again the moment the ordering sees it: `releaseBoards` holds any board whose
  supply is on the way, so the shop would buy for it, which is exactly the
  freezer the reservation was meant to take back. It is the line `giveUpBoard`
  and `orders.assign` already draw, said about the third of the shop's
  judgements. The trap it leaves: `shelfAccepts` is the **hand's** copy of this
  rule and not the shop's — `takers` is `!p.staff` — so it has to carry the
  exemption too, or the chevron is the tighter half of a disagreement and a unit
  takes a press it never lit up for.
- **…and an existing control that already vetoes the new thing is not the same
  as a switch for it.** The shop hand shipped with a reservation as its only
  veto, which is true and was not the control: a reservation says what a board
  is FOR, so hands-off is its side effect, and it only ever covered the units
  you already had plans for. Every shelf you had said nothing about was fair
  game, and the only way to say "leave that one alone" was to tick an item onto
  it you did not want there — a control used for its side effect, which is the
  shape of a missing control. `shelf.managed` is the switch (`setShelfHands`,
  read by `staleBoards` and by BOTH ends of a merge, since a locked unit that
  quietly grew a board is a unit the hand rearranged). It defaults to true so no
  save moves, which is why `persist`'s shelf filter had to learn that a switch
  flipped on an *empty* unit is still worth saving.
- **…and a PREFERENCE stops meaning anything at the moment it is tested.**
  `shelvesFor` has always ranked the unit an item is already on first, which
  reads as "the shop keeps things together" and is only ever consulted when
  there is a choice. Fill that unit and there is no choice: the next armful
  claims a bare board next door, and from that tick one item has two homes. It
  compounds rather than settles, because each board is its own line in
  `restockQueue` — so the shop starts buying for both, and what you are looking
  at four days later is four shelves of produce nobody asked for. Every single
  decision in that chain is a worker correctly putting goods on a shelf with
  room, which is why it reads as the staff being stupid. `Game.homeShelves` is
  the rule the preference was standing in for: the units you TICKED, else the
  one holding the most, and `boh` homed separately because a stockroom backing
  up the floor is the second place that is the point. Three things about it.
  The losing board is consolidated **by never being chosen again** — it drains
  and `releaseBoards` hands it back — which needs no job, no walk and no latch,
  and works in a shop whose one clerk has no `merchandise` job. That release had
  to be asked BEFORE the supply guard: `homeSupply` is above zero for ever for
  anything you farm, so a spare tomato board next to two tomato beds could not
  age a single day. And `pickItem`'s `?? scored[0]` fallback had to go — it
  fired precisely when every item that fits a unit was already stocked, so the
  one function whose job is choosing the *range* was deliberately buying a
  second board of the best seller.
- **A STARTING VALUE is a behaviour change when the thresholds below it are
  absolute — and `MOOD_BASE` broke two constants that way at once.** It lowered
  the mood a shopper walks in on from 1 to 0.6–0.7, and docs/difficulty.md said
  of it that "everything downstream in `stepMood` is untouched, so a queue costs
  what a queue costs". True in budget-per-second; false in *seconds*, which is
  the only unit anybody can see. `patience` is a budget and the drain is
  absolute, so an authored 70 bought about 45 seconds and `ANNOY_LINE`'s "runs
  out in exactly `patience` seconds" anchor stopped holding for every archetype
  simultaneously — and because `MOOD_ANNOYED` is absolute too, time from the
  door to somebody *looking* cross in a queue fell **3.35x** (a Snack Kid: 13
  seconds to 3.9). The drain is scaled by `cust.mood0` now, which restores the
  storm-out anchor exactly and deliberately leaves the shortened fuse to anger,
  because that half IS the feature and charm is what buys it back. The second
  casualty was the same shape pointed at money: a visit's reputation gain is
  `REP_VISIT * (mood - MOOD_ANNOYED)`, scaled to a mood of 1 that
  `ANNOY_IN_SHOP` guarantees nobody reaches, so it paid a fifth of its own
  ceiling — against a flat per-line miss charge it could never out-earn, which
  made a good day come out negative and pinned every shop at the settle floor.
  **Whenever something changes where a number STARTS, list every absolute
  threshold underneath it** — each one is a rule whose meaning just moved, and
  none of them looks wrong afterwards.
- **Whatever you change, check the balance bot still models a player doing it.**
  Auto-replant meant plots were never empty, and `simulate` skipped any planted
  plot — so every bed froze on its first crop and three crops reported as
  `deadStock` with perfect tags. The tool said the feature was −39%; the tool
  was wrong. A broken instrument reads as a broken feature.
