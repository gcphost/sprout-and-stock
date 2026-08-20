# Sound

Status: **steps 2, 3, 4 and 5 built. 1 tried and cut; 6 proposed.** A lofi
playlist on its own bus, eighteen one-shots wired to a snapshot diff, one loop a
fixture names off its own catalog row, and a Sound tab with a mute and three
volumes beside a Credits tab generated from the manifest. Nineteen files, all
CC0, ~7.6MB. No dependency.

The one-shots that matter most are the two that report a shopper losing
patience — an `anger` crossing you can still act on, and a walkout you cannot.
Both happen in an aisle you are not looking at, which is the whole argument in
"Why it exists".

The ambient crowd bed is the one thing here that was built and removed — see
"What was tried and cut", which is still the most useful section in this file.

---

## Why it exists

The shop is silent. Everything it does is *visible* and nothing it does is
audible, which is fine right up until you look away from the screen — and you
look away constantly, because half of shopkeeping is reading a panel. A
delivery arrives, a shelf empties, somebody walks out angry, and the only
report is a line in the corner feed that ages out after seven seconds.

Sound is the channel that works while you are looking somewhere else. That is
the whole argument, and it is what decides which sounds are worth having: a
noise for a thing you were already watching is decoration, and a noise for a
thing that happened behind you is information.

The second argument is that a shop with people in it should *feel* like a shop
with people in it. `occupancy` has been on the wire since the shop had
customers and the only thing that ever reads it is a meter. A busy shop and an
empty one currently differ by some dots moving.

## What was tried and cut

Step 1 — the mixer, an ambience bed and a crowd layer that swelled with
`state.customers` — was built, played, and taken back out the same afternoon.
It is worth knowing what happened before anybody builds it again.

**It was synthesised first, and filtered noise is rain.** Noise through a
bandpass with a slow swell on it is a completely reasonable *description* of a
busy room and it sounds exactly like weather, because that is what it is:
broadband, steady, swelling at weather speed. Filtering it differently does not
help — rain and babble occupy the same frequencies. What separates them is that
speech is chopped at the syllable rate, three to five times a second, and a room
is many such envelopes running out of step with each other. That is
reproducible with an oscillator bank per voice, and the result is still audibly
a machine imitating a room.

**Then it was two real recordings, and that was not the problem either.** Two
public-domain mall recordings off Wikimedia Commons, crossfaded by headcount,
seamlessly looped. It worked, it was correct, and the verdict was still that it
was not worth having.

So the lesson is not about synthesis. It is that **an ambient bed is the least
valuable sound in the list and it was built first because it was the most
interesting to build.** Re-read "Why it exists" above: the argument for sound
here is that it is the channel that works while you are looking at a panel — a
noise for a thing that happened *behind you*. A crowd bed reports something you
can already see, has no moment, and answers no question. The three caps under
"The budget" exist to stop noise nobody asked for, and the bed is that by
construction: it is *always* playing.

If this is picked up again, **start at step 3.** A till, a delivery arriving, a
shelf going empty — things with a moment attached, which is what makes a sound
information rather than furniture. The bed can come back afterwards if the shop
sounds thin without one, and it will be a much easier call to make with
something else already in the mix.

The mixer, the arming-on-first-input, the `localStorage` volumes and the
`passive` credits tab were all fine and all survived — the bed was cut, not the
audio. Steps 2, 3 and 5 were built straight afterwards on exactly that
foundation, which is the evidence for the paragraph above: none of the work was
wasted, only the one layer that reported something you could already see.

## The shape

Rows marked ✅ exist.

| Piece | Lives in |
|---|---|
| ✅ the mixer — context, buses, master volume | `client/audio/mix.js` |
| ✅ the music bus and its playlist | `client/audio/music.js` |
| ✅ one-shots, the voice pool and the caps | `client/audio/sfx.js` |
| ✅ what file every sound id means, and who made it | `client/audio/manifest.js` |
| ✅ the files | `client/audio/sfx/*.ogg` and `music/*.ogg`, bundled by vite |
| ✅ the snapshot diff every sound comes off | `client/audio/events.js` |
| which sound a fixture makes | the `sfx` column on a `fixtures` row |
| ✅ the sliders and the mute | a Sound heading under the Menu's Game tab, `client/sections.js` |
| ✅ the credits | a `passive` tab of its own, generated from the manifest |
| ✅ where the volumes are kept | `localStorage`, never the save |
| ✅ waking it up on the first input | capture listeners at the top of `client/main.js` |
| the guard | `scripts/verify-audio.js` |

Client-only. The server has no ears the way it has no renderer, and nothing
about sound should ever reach `server/` — a sim that decides what you hear is a
sim whose balance depends on your speakers.

---

## Three buses, and only three

**Ambience** — one room-tone loop per place you can be, always on, quiet, never
changing. It is the floor the other two stand on and it should be the thing
nobody ever notices.

**Crowd** — a murmur loop whose *gain* is a function of how many people are in
the shop. This is the ebb and flow, and the important thing about it is that it
is a **volume, not a trigger**: no event fires it, nothing schedules it, it just
tracks a number. An empty shop is silent, a busy one swells, and the transition
is a smoothed follow rather than a step — a gain that jumps on the tick a
shopper spawns pumps audibly, and reads as the audio glitching.

**Music** — its own bus, its own slider, and off by default until somebody
decides otherwise. Lofi loops, crossfaded, with a real gap between tracks.

Everything else — a till, a door, a crate landing, a crop picked — is a one-shot
on the SFX bus, which is not a fourth bus so much as the master with a cap on it.

The buses are separate because the sliders are. A player who wants the shop
noise and not the music has asked a question the mixer has to be able to answer,
and one gain node cannot.

---

## The rules

### A sound is content, not code

Which noise a fixture makes belongs on its catalog row, next to `emits` and
`model`, for exactly the reason those are there: somebody authors a new
appliance over MCP and it should make a noise without a file edit. The column
is `sfx` and it is a small JSON object, the same shape `emits` is:

```
sfx: {
  loop:  'fridge-hum',   // while it exists, or while it is working
  use:   'till-beep',    // when somebody uses it
  done:  'oven-ding',    // when a batch finishes
}
```

Every field nullable, the whole column nullable, `'null'` the default — which
is what every row written before sound existed means, and is why nothing in a
live shop changes on the day this lands. It goes in `ADDED_COLUMNS`
(`server/db.js`) and in the JSON-column list beside `emits`, and `sfxShape` in
`shared/schemas.js` mirrors `emitsShape` line for line.

`loop` is the one that needs care, and it takes its cue from the `motion` flag
in [docs/fixtures.md](fixtures.md): **a thing that knows what working means
loops while it works, and a thing that does not loops always.** A fridge hums
forever; a blender only while it is running. Without that second clause the
field silently does nothing on every kind except `station`, which is the "tier
that changes no number" trap wearing headphones.

What stays in code is the *rules*: how many can play at once, how far away is
too far, what ducks what. Same line `BUILD_KINDS` draws.

### Ambience is a gain, and the number is already on the wire

`state.customers` is the crowd, and it is honest: `snapshot()` filters
`!inACar(c)`, so people still driving up the road are not in that array. That
filter is doing real work here — without it, the murmur in an empty shop would
be driven by somebody two hundred tiles away on the approach road, which is the
same bug `stepMood` had and is invisible until you notice the shop sounds busy
at 8am.

Three other snapshot fields matter:

- `occupancy` and `turnAwayAt` — the crush, which is a better input than the
  raw count for how *stressed* the murmur sounds, because it is already scaled
  against the shop's own size.
- `isOpen` — shutters down means no crowd bed at all, whatever is standing
  inside.
- `paused` — the renderer already has to be told (`scene.paused`, because
  `animateStations` runs on the page's clock rather than the shop's). Sound has
  the same problem and worse: a room tone continuing under a paused shop reads
  as the pause not working, which is precisely what a blade still turning read
  as.

And one trap that is not a field. The night is **compressed** in `step`
(`NIGHT_SPEED`, 3× today and 6× when this was written), so between 20:00 and
08:00 the clock runs faster than the room does. Anything that schedules audio
off world time — a chime on the hour, a shift change — fires that many times as
often overnight, and the multiple is a number somebody may retune. Ambience is safe because it is a gain rather than a
schedule; that is a third reason for the rule, not a coincidence.

### The budget is what stops it being a slot machine

A shop with twenty shoppers, four staff, three appliances and a delivery
arriving generates far more events than anybody wants to hear. Four caps, and
they are cheap:

- **Six voices.** A seventh one-shot steals the oldest. Not "queue it" — a
  sound played late is worse than a sound not played, because it is attached to
  the wrong moment.
- **Dedupe by id within 80ms.** Four sales in one tick is one till noise.
- **Offscreen is silent.** If it is outside the camera frustum it makes no
  sound, however loud it would have been. This is the single biggest one: a
  farm at the far end of the map should not be audible.
- **Pan by screen x, attenuate by screen distance.** Not three.js
  `PositionalAudio` — that wants a listener graph and an orientation, and the
  camera here is a fixed isometric on a leash. Two numbers off the projected
  position do the whole job.

The rule underneath all four: **a sound is a report about something, so two
sounds that report the same thing is one sound.**

### The events do not come from the log

`snapshot()` sends `log: this.log.slice(-8)`, and it is tempting, because the
lines are already written and already say what happened. It is the wrong source
and would fail in two ways that are hard to see.

It is a **rolling window inside a snapshot**, so it is a picture rather than a
stream: `ui.js` reads only the newest line and only when its text differs from
the last one it saw (`last.msg !== this._lastLog`). Three sales in one tick
surface one line, and two identical lines in a row surface one — which is
exactly right for a corner feed nobody should have to read, and exactly wrong
for a till that should click three times. Driving sound off it means every busy
moment, the moment you most want to hear, is the moment that under-reports.

And it is **prose**. Matching `/^Sold (\d+)x/` against a message somebody may
reword is a sound effect that stops working because a log line got clearer.

So sound rides on two things instead. Most of it is a **diff of the snapshot** —
cash went up, a crate appeared, a plot became ripe, the van reached the dock —
which the client is already doing for the renderer and which is robust to a
dropped frame, because a snapshot is a picture of *now* and two pictures always
differ correctly. The handful that a picture genuinely cannot carry gets its own
message, the way `achieved` does, and `net.js` already spells out why: an event
is not a state, and asking the client to find it by diffing means a dropped
frame at the wrong moment is a thing nobody was ever told about.

---

## Where the sound comes from

Licence first, because it is the constraint that actually narrows the field, and
because [docs/shipping.md](shipping.md) wants a standalone binary somebody can
hand to a friend.

**Wikimedia Commons earned its place on this list** during the cut step above,
and it is first for a reason nothing else here can match: its API returns the
licence and the author as *structured fields* beside the file, so the credit can
be read rather than transcribed. Transcribing is exactly where a credits list
goes wrong. `action=query&generator=search&gsrnamespace=6` with
`gsrsearch=filetype:audio …` and `iiprop=url|extmetadata` is the whole query,
and the ambience it found (public domain, usable, correctly credited in about
two minutes) was fine — it was the *idea* that was cut, not the sourcing.

| For | Source | Licence |
|---|---|---|
| Room ambience, with machine-readable credits | **Wikimedia Commons** (`filetype:audio`, filter to PD/CC0) | varies, stated per file |
| Store ambience, tills, doors, fridges, trolleys | Sonniss GDC Game Audio Bundle | royalty-free, no attribution |
| Lofi background music | Pixabay Audio | Pixabay licence, commercial, no credit |
| UI blips, coins, pops | Kenney.nl | CC0 |
| One specific noise you cannot find elsewhere | Freesound.org, **filtered to CC0** | CC0 |
| Music, if the credits screen is worth it | Incompetech, FreePD, OpenGameArt | CC-BY, credit required |

The first four need no credit at all. The fifth does, and we are taking it —
which is the point of the credits screen below, and means Incompetech's back
catalogue is on the table rather than off it.

What is **not** on the table: anything with a non-commercial clause, anything
sample-pack-licensed (those forbid redistribution in a form somebody could
extract, which is what shipping a game is), and anything where the licence has
to be worked out from a forum post.

### Sizes

Mono Opus at ~64kbps for one-shots, stereo at ~96kbps for beds and music. A
two-minute lofi loop lands around 1.4MB, a till click around 3KB. Thirty
one-shots, four beds and six tracks is roughly **10MB**, which is fine bundled
and would not be fine as thirty separate fetches on a cold load.

They go in `client/audio/` and are imported, not fetched — vite fingerprints and
bundles them, so the tunnel and the binary both get them without a manifest of
URLs that can rot.

---

## The settings, and the credits

Both go in the Menu — the `help` section in `client/sections.js`, which is
already tabbed and already has a shape that takes them. `tabGroups` in `ui.js`
turns any `sep` row **with an icon** into a tab and leaves a bare one as an
ordinary divider, so the two land differently on purpose:

```js
{ sep: 'Sound', icon: ICONS.music, passive: true },   // a tab: volumes, then
{ sep: 'Credits' },                                   // a heading inside it
```

They shipped the other way round — a `Sound` divider inside the Game tab
holding a mute and three volumes, beside a `Credits` tab — on the argument that
four volume rows are not worth a click and settings you have to go looking for
are not settings. Half of that survived and half did not, and the line between
them is **switch or degree**. The *switch* is what you open this menu for and it
stayed on the Game tab, in the block of tiles with the tour and the two corner
widgets (`switchGrid`); the three steppers are a thing you set once, ever, so
they moved next to the playlist they are about. What is left is one tab about
sound — how loud each part is, and who made it — which is one subject, and a
Game tab whose every row is a press you might actually make today.

`Credits` is a bare divider inside it for the reason `Sound` used to be one:
a licence list is long, but it is not an *alternative* to the volumes, and a
tab strip is a promise that the tabs are alternatives.

`passive` is what stops it *opening* on that list. It marks a tab that
**reports** rather than offers work, and all it forfeits is being the one the
menu opens on — so pressing `/` lands you on Game, which is the point.

### The controls are rows, not widgets

There is no slider in this game and there does not need to be one. Two shapes
already in `sections.js` do the whole job, and both are already styled, already
keyboard-reachable and already redraw off `live`:

- **Mute is a switch** — one tile in the Game tab's `grid`, beside the tour and
  the corner widgets. It was the `picked` / `tail` / `run` row shape the
  supplier settings use, and a row is a sentence: glyph, name, caption, state.
  A switch has no use for the middle two — you know which one you want before
  the panel is up, and all you need back is that it moved — so the caption is
  the tile's `title` and the state is the tile being lit.
- **A volume is a stepper** — the `stp` widget from `ruleFor`, `− 60% +`, in
  steps of ten. A row per bus: Shop, Music, Effects.

A tab needs a glyph, and icons are **baked** rather than imported —
`scripts/build-icons.js` lifts named icons into `client/icons.js` at build time
and the output is committed, so a tab whose `sep` names an icon nobody added is
a `undefined` in the tab strip. Two entries in `WANTED` and one `npm run icons`.
They are interface chrome rather than things in the world, so they come from
remix-icon, which is the split that build script exists to keep: *the world
never looks like a settings screen and the settings screen never looks like a
dungeon crawler.*

A stepper rather than an `<input type=range>` is not a compromise. A drag inside
a panel fights the panel's own drag (`panel-drag.js`) and needs a pointer, and
this game is played with a pointer that means something everywhere else. Ten
steps is finer than anybody adjusts a game volume anyway.

**They belong in the same menu as the controls list because they are the same
kind of thing.** Everything else in the rail is about the shop — what it owns,
what it sells, how it is doing. This is the only menu about the *game*, which is
also why "leave to menu" is in it. `orderRows` already made this call in the
supplier — "they are settings, and settings are somewhere you go."

### The volumes live in `localStorage`

Not on the save. A volume is about the person and the room they are sitting in,
not about the shop, and two people playing one world down the tunnel must not
share a knob — one of them turning the music down would turn it down for the
other, in a different house. `panel-drag.js` is the precedent for a per-browser
preference that never touches the world, and it stores through one try/catch for
the same reason: a browser with storage blocked should lose the preference, not
the audio.

### The credits rows are generated, never typed

This is the same rule `client/thumb.js` is built on — a picture of a thing has to come from the thing,
because a hand-drawn second version of something is wrong the moment the first
one changes and nobody ever checks. A hand-typed credits list is worse than a
wrong thumbnail: it is a licence condition that quietly stops being met. Every
entry in `manifest.js` carries `by`, `from` and `licence` beside its file, the
tab renders whatever is in there, and a track added without them fails the
verify below rather than shipping uncredited.

That panel needs a better layout at some point regardless — five tabs of
one-line rows is already tight, two more makes seven, and a licence list is
longer than anything else in there. Neither tab is what breaks it and neither
should wait for the refit. What the refit should probably do is admit what the
menu has become: the keys are a reference, Sound is a setting, Credits is a
notice, and the shop you are in and the way out of it are neither. That is a
split by *kind*, and the tab strip is currently a split by topic.

---

## Steps

**1. The mixer and the bed.** Built once, cut once — see "What was tried and
cut". If it comes back it should come back *after* step 3, and the useful
leftovers are: three buses behind one `arm()` on first input, volumes in
`localStorage`, and a crowd curve anchored at **one** person rather than zero.

That last one was a real fix. Anchored at zero, the step from nobody to one
shopper is the loudest thing on the whole range — more than the entire span from
five people to ten — so a single browser wandering in starts a murmur, which is
a noise one person alone in a shop does not make. Anchored at one it says the
true thing: one is not a crowd, and what you hear is the shop filling rather
than the door opening.

**2. Music.** The bus, a playlist, crossfade, a real gap, its own slider,
default off. Independent of step 1 and can land either side of it.

**3. The one-shots the shop already justifies.** A fixed table in `sfx.js`, the
voice pool and all four caps. About a dozen sounds — a sale, a delivery
arriving, a crate down, a crop picked, a shelf emptied, a door, a milestone.
Driven off the snapshot diff, plus one new server message for anything a picture
cannot carry. No content column yet: getting the caps right matters more than
getting them authorable, and a dozen hardcoded sounds is the cheapest way to
find out whether six voices is the right number.

**4. The `sfx` column. Built.** `sfxShape` in `shared/schemas.js`, the column in
`ADDED_COLUMNS`, the JSON list beside `emits`, and the loop rule (works-while-
working, or always for a thing with no idea what working means). Now a new
appliance authored over MCP makes a noise. The fixed table from step 3 stands
where it was, as the sound for things that are not fixtures at all — a sale, a
crate, a shopper — and a piece that names nothing is simply quiet.

Three things it turned out to rest on, none of them in the plan above.

**The loops are a LIST, not starts and stops.** The truth about which machines
are running arrives as a snapshot, so the client can always say what should be
sounding and can never reliably say what just changed — which means a
`startLoop`/`stopLoop` pair leaks a hum into an empty shop the first time a
frame is dropped, a fixture is sold from under one, or a tab is left. `setLoops`
reconciles a whole list, so anything not in it is not playing by construction.

**Keyed by tile, for the reason the tier diff is.** A rung or a turn re-mints a
fixture's id on the same square, and building re-flows on every wall segment of
a drag — so a loop keyed by id would stop and restart continuously while you
extend the shop, which is this file's own "a re-flow must not restart the
ambience" arriving as a stuttering fridge.

**Out of earshot is stopped, not turned down**, which is the gotcha below about
a gain of zero, said about the fourth freezer rather than about the crowd bed.
Four loops, nearest wins — the same call `lights.js` makes about the ninth lamp,
made before there was a catalogue of humming fixtures to trip over it.

And one number that is not a preference: **the loop is mixed far below every
one-shot** (0.16 against 0.5–0.95). A one-shot is a report you hear once at a
moment you were waiting for it; a loop is on for as long as you stand there, and
a background you *notice* is a background you mute the game to be rid of.

**A fridge hum shipped beside it and was cut the same day**, which is the useful
half. It was the textbook case for the second clause of the loop rule — a thing
with no idea what working means, humming always — and the rule is still right;
the sound was not. An appliance running is a thing that *started*, so the noise
is news. A freezer is on from the day you buy it until the day you sell it, so
the noise is never not true, and a report that is always true reports nothing
and can only sit under every other sound in the game. That is the ambient bed's
verdict arriving from the other direction, and the two together are worth
stating as one rule: **a loop has to be able to be false.** The file went with
it, per step 6's third claim — an asset nothing names is a download every player
pays for and nobody hears.

**5. The Sound tab and the Credits tab.** Both were built during step 1 and went
out with it, and both were fine. The Sound tab belongs *with* whichever step
first makes a noise rather than after them all — the first thing anybody does
with new game audio is turn it down, and a bus with no way to silence it is a
feature you cannot play-test twice.

Only list a row per bus that exists. A knob that turns nothing is the same trap
as a tier that changes no number: it looks finished, it takes an input, and
nothing happens.

**6. `verify:audio`.** Small and worth having, because every failure in this
system is *silence*, and silence is indistinguishable from a quiet moment.
Four claims:

- every `sfx` id any authored piece names resolves to a file in the manifest —
  a typo is a fixture that is simply mute, and nothing renders it, nothing logs
  it, and it looks exactly like a fixture that is meant to be quiet
- every file in the manifest carries `by`, `from` and `licence`, or the credits
  tab is a licence condition met by accident
- nothing in the manifest is orphaned — a file nothing plays is a megabyte in
  the binary
- the caps are the caps: feed the pool fifty one-shots in one frame and assert
  six voices, not fifty

It cannot assert anything about how it *sounds*, the same way `verify:motion`
cannot — which is exactly why `verify:motion` exists, and it is the closest
sibling this would have.

---

## Gotchas, ahead of time

- **A browser will not start an `AudioContext` until the user has clicked.**
  It has to arm on the first real input, not on load. Miss this and it works
  perfectly in the dev tab — where you have clicked a hundred times — and is
  silent for every fresh player, which reads as the sound being broken rather
  than as being asleep.
- **A gain of exactly 0 is not the same as a stopped loop.** A silent oscillator
  still costs a node and still gets scheduled; four beds at zero gain is four
  decoders running for nothing. The crowd loop should stop below a threshold and
  start again above one, with hysteresis, or it stutters at the boundary every
  time somebody walks in and out of the door.
- **`disposeGroup` does not free audio.** It looks for `isMesh`, and it already
  did not free sprites until that was fixed. Anything holding a buffer source
  has to be torn down where it was created — `movingFixtures` is the pattern:
  filled and cleared in the one place that builds them.
- **A layout re-flow must not restart the ambience.** Building re-flows on every
  wall segment, and a bed that faded back in on each one is the car-that-never-
  arrives bug said with sound: a player who is extending the shop would hear it
  stutter continuously, precisely while doing the thing that makes the shop
  worth listening to.
- **A mute has to survive the arming gesture.** The context starts suspended
  until the first click, and the volume comes back from `localStorage` — so a
  player who muted last session, then clicked to arm, must not get one frame of
  full-volume audio between the two. Read the preference *before* resuming, not
  in whatever runs next.
- **A tier that changes no number, said about sound.** A `sfx` field nothing
  ever plays is the same trap as `capacity_mult` on a kind that never reads it —
  it authors fine, validates fine, costs money if it is on an upgrade, and does
  nothing. Which is what step 6's first claim is for.
