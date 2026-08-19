# Sprocket & Stock — working agreement

A shop-and-farm game staffed entirely by robots, built by two people at the same
time, each with their own agent, against one shared running world.

The player is the only human who works here. Every hire is a machine — that has
been true of the *art* since workers became content (`server/sim/names.js` draws
staff from a machine register and shoppers mostly from a human one), and as of
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
press in the game now goes through it. And the client half of the same rule:
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
Twenty-three sweeps, about half a minute:

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
- `verify:motion` guards the one thing a screenshot can never show: whether the
  thing was moving. That a part flagged `motion` becomes the *right* moving part
  even when a `seam` is dropped past it — the meshes are not the parts, so an
  index taken afterwards spins the box next door and reads as bad art; that a
  spin ACCUMULATES, or a blade eased to a stop drags itself back to where it was
  drawn and the machine appears to rewind; that an idle machine sits *exactly*
  where it was drawn, not nearly; and that a `work` model answers to the batch
  while a `model` answers to the tier, which is the whole reason there are two.
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
  SHELVING. It authors two items, a piece and a worker, and removes them on exit.

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
  with no fold, no summary and no held re-flow. It authors nothing.

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

Each of the first twelve found real bugs the day it was written, and so did
`verify:hot` — two, both of them a list of kinds somebody had written out by
hand — and so did `verify:orphans`, which is the only one so far written to a
bug reported from a screenshot, and so did `verify:store`, which caught ninety
rows on its first run and is the only one that found its bug *before the feature
it guards had ever run*. `verify:motion`, `verify:hand`, `verify:park`
and `verify:doors` are the exceptions and say so: each shipped with its feature,
because every claim it makes is invisible in a still frame by construction. None of them is visible in a screenshot of one
seed — which is exactly why they exist.

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
| Rendering internals | `client/render/scene.js` | |
| Economy and balance | `server/sim/economy.js` | Re-run `simulate` after every change. |
| Customer behaviour, crops, actions | `server/sim/index.js` | The biggest file. Coordinate before restructuring. |
| Layout generation | `server/layout.js` | Re-run `npm run verify` after every change. |
| Build placement rules | `shared/build.js` | Imported by **both** client and server on purpose — see below. Also owns `GROUND` — the brush that paints floor and the road (a look), and the bay, the drop-off, the break area and the car park (a job). None of the six is a fixture. |
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
            reputation.js the seven things that move the shop's reputation, and
                          the words for them — the sim writes the keys, the Shop
                          report draws them, `simulate` names the worst one
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
| [docs/building.md](docs/building.md) | walls on tile edges, enclosure instead of a store rect, the kinds-vs-pieces catalog that makes lights and decorations authorable, prices that live on the catalog, and the ground brush that paints floor, the two yard pads, the break area and the ground outside alike, who a way through is for — staff only, entrance only, exit only — and the ground pattern that has height | steps 1–9, 11, 13–18 built; 10 cancelled; 12 next |
| [docs/workers.md](docs/workers.md) | workers as authored content, the roster, tier ladders, breaks, the props that make them visible, the break area they are taken in, the shop hand who takes goods back *off* a shelf, and the three farm directives that became one | steps 1–6 and 8–11 built; 7 proposed |
| [docs/customers.md](docs/customers.md) | patience as a budget every annoyance draws on, anger you can see, theft, a shop that turns people away when it's full, the list they came in with, and the regulars who come back — a name with a memory, kept on the save rather than in the content database | steps 1–4 and 6–9 built; 5 and 10–12 proposed |
| [docs/ordering.md](docs/ordering.md) | what the shop buys without asking — counting crates and the farm before spending, the shop-wide switches, the per-item standing order, a supplier tabbed by what to do rather than by where a thing lives, and the shelf menu that says what is on the van, orders more of a board, counts what the shop already has and shortlists what to keep it for | steps 1–5 built |
| [docs/deliveries.md](docs/deliveries.md) | why an order should be a promise rather than a teleport — runs and cutoffs, the van as authored content, the lane it drives down, and the car park that is the same idea pointed at customers, the lane a shopper's car drives in and out on, and the road and pavement brushes that decide which way in that is on wheels and on foot | steps 1–7 built |
| [docs/kitchen.md](docs/kitchen.md) | why a machine knows several recipes and runs one, and the rung that buys a second *slot* rather than more speed — one hopper feeding two heads, a tray per slot, the picker turning into a capped list of ticks, and the two clocks a twin machine has that one resolver cannot answer | all proposed |
| [docs/kits.md](docs/kits.md) | what a shopper is carrying their shopping *in* — a content table of things somebody has on them, the moment/tags pair that assigns one, why the draw is a hash rather than an rng, and the basket you walk over and fetch | step 1 built; 2–4 proposed |
| [docs/progress.md](docs/progress.md) | the milestone ladder — twelve rungs that are *measurements* rather than quests, the three rewards a rung may pay (money, a free run of stock on the next van, and the town growing), and the card that stops the world to say so | step 1 built |
| [docs/difficulty.md](docs/difficulty.md) | why a neglected shop finds a level instead of going under — the settle spring, the floor under demand, and a game where standing still is free; difficulty as a second axis beside the starting tier, upkeep as the first fixed cost, and why today's constants are the *easy* preset rather than the default | step 1 built; 2–4 proposed |
| [docs/ui-shell.md](docs/ui-shell.md) | the HUD, the rail, panels | — |
| [docs/tutorial.md](docs/tutorial.md) | the robot who shows you round a shop you have just made — a veil that blocks rather than only darkens, a step that is a predicate over the snapshot rather than a press it caught, and the third answer to "where is the hole" that stops it ever wedging | step 1 built; 2–4 proposed |
| [docs/audio.md](docs/audio.md) | a bus per slider, why the sounds cannot come from the log, the four caps that stop a busy shop being a slot machine, sound as a column on a catalog row, the Sound rows and the Credits tab in the Menu — and why the ambient bed was built, played and cut | steps 2, 3, 5 built; 1 cut; 4, 6 proposed |
| [docs/waste.md](docs/waste.md) | the shop's way out — the skip, why a hire may carry out rot and never your stock, rot becoming a box on the floor only if you own one, and the one spelling that keeps rubbish from reading as supply | step 1 built; 2–3 proposed |
| [docs/pickups.md](docs/pickups.md) | the customer who never comes in — a collection point as a till whose queue is fed by the road, why picking is `serve` rather than a new job, why a staged tote is not stock, and the share that is a consequence of owning one | all proposed |
| [docs/seating.md](docs/seating.md) | the customer who stops — the break area pointed at shoppers, why the cell is the seat and the bench is a multiplier on it, the first honest dwell impulse has ever had, and the four readers that must NOT share a predicate | all proposed |
| [docs/browser.md](docs/browser.md) | the whole game on a URL — the server moving into the tab, the two seams (transport, store) that keep one codebase serving two targets, why the browser build has no SQLite in it, P2P over a data channel and the signalling that is not free, a host tab throttled to 1Hz, and the MCP surface that is the price | steps 1–7 built; 8 open on numbers nobody has yet |
| [docs/shipping.md](docs/shipping.md) | the standalone binary, inviting one friend in, the session token that is also the invite code, MCP as the shipped mod surface, and what a disconnect does to whatever you were holding | steps 2–4 built; 1, 5–8 proposed |
| [docs/steam.md](docs/steam.md) | selling it on Steam for Windows and macOS — the shell that keeps the renderer we have tested on, a server nobody can find, why Steam Cloud and SQLite's WAL disagree, the 43 milestones that are already an achievement list, why the model call leaves the build and `inventEvent` *is* the director, and why Steam's own relay retires the invite code | all proposed |
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
  hold is the whole board into a crate you watch fill.** The hold is the only
  action in the game that fires more than once (`repeat` in `stepActions`,
  `crateBoard`), and the crate was always its ending — a board holds more than a
  pair of hands, so "take it all" only means anything if what it fills is a box.
  What is new is that the box fills *across* the second the ring already cost
  instead of appearing at the end of it, so letting go at half a second leaves
  you with half the board. Six things fall out of it.
  **`PULL_SECONDS` is a duration, not a rate.** The interval is a second divided
  by how many units are coming (`pullEvery`), so a board of three and a full one
  take the same hold — a per-item timer makes a big board a chore and the
  gesture stops being one decision. Worked out ONCE, at the tick it arms:
  `p.action` lives for the whole pull and `stepActions` resets only its clock,
  because a board that is draining answers a smaller `n` every tick and a pull
  that re-read it would accelerate to nothing.
  **Onto the shoulder, not the floor.** `p.haul` is the point — walking off with
  the lot — and a crate at your feet is a second gesture to pick up. Which is
  also why loose goods in your hands refuse the whole pull: nobody shoulders a
  box while holding six loaves.
  The **errand outlives its own units** — spent on the first one, the second has
  nothing to arm from and a hold takes exactly one — so "an errand is spent when
  it fires and nothing re-arms" now reads *except while the button that fired it
  is still down*. Walking away spends it (`stepActions`), or it would still be
  armed when you came back to that shelf for something else.
  A pull is the **first job that spans ticks while what you are carrying
  changes**, and two verbs driven by the POINTER were written on the assumption
  that nothing does: `aimAt` and `clearAim` say where a load should GO, which
  goes live the moment the crate exists, and either one arriving mid-pull ends
  the gesture in your hand. `pulling(p)` is the yield — `repeat` **and** `took`,
  so the offer is the pointer's right up until goods actually move.
  It is **said once, at the end, with the total** (`endPull`): twelve lines of
  "Took 1x Bread" is one event told twelve times. A job loop has no button to
  let go of, so the staff callers leave `unshelve` alone and still sweep a board
  in one step.
  And **a release that ends a hold is not also a tap.** The client rules a press
  a hold at `LONG_PRESS_MS`, and a nearly-bare board hands its first unit over
  before that — so a short hold sends the tap as well, and you would come away
  with the board in a crate *and* a loaf you never asked for. `tapBoard`
  swallows it on `pulling`, which is the test the client cannot make: only the
  shop knows whether goods actually crossed under that button.
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
  **byte-identical** takings over three seeds. Every `verify:*` sweep passed
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
  `capacity_mult`, `keeps_mult`, `speed_mult` and `unattended` are the only knobs
  the sim reads. The till ladder was priced at 0 for exactly that reason until
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
- **Whatever you change, check the balance bot still models a player doing it.**
  Auto-replant meant plots were never empty, and `simulate` skipped any planted
  plot — so every bed froze on its first crop and three crops reported as
  `deadStock` with perfect tags. The tool said the feature was −39%; the tool
  was wrong. A broken instrument reads as a broken feature.
