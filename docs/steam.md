# Steam — a thing somebody buys, on Windows and macOS

Status: **nothing built.** Everything here is proposed.

[docs/shipping.md](shipping.md) already decided the *shape*: a downloadable
binary, single-player by default, one friend invited in, MCP shipped as the mod
surface. This doc is the half that document does not cover — what a **store**
demands on top of a binary, and the four places Steam is not simply "the binary,
distributed".

The two documents are meant to be read in order. Where they disagree, this one
wins, because a Steam release retires two of shipping.md's steps outright: Steam
brings its own identity, its own relay and its own updater, so the invite-code
design (steps 5–6 there) is work you would do and then throw away.

---

## What is already true, and it is more than you'd think

Worth stating first, because the remaining list reads long and most of the hard
parts are behind you:

- **The sim runs headless.** `simulate` proved that years of features ago. There
  is no "extract the game from the browser" step.
- **The save is a local file.** SQLite, and `SNS_DB` already redirects it — built
  for frozen-world measurements, and it is the one line a packaged app needs.
- **Pause exists**, world-wide, saved as a stamp, and the renderer is told about
  it. That was shipping.md step 4 and it is done.
- **Identity outlives the socket.** `who` in local storage, `Game.away` in the
  save. Step 3, done, and a Steam release gets to *replace* the minting of it
  with a SteamID rather than to write it.
- **A disconnect no longer destroys goods.** Step 2, done.
- **Every sound and every track is CC0**, and the Credits tab is generated from
  `client/audio/manifest.js` rather than typed. The single most common way an
  indie release gets pulled — music somebody licensed for a video — is already
  not a risk here, and the *mechanism* that makes it safe (credit as structured
  fields beside the file) is the one to reuse for code licences below.
- **There are 43 milestones** in `server/sim/goals.js`, each a measurement of
  state the shop already keeps. That is an achievement list that already exists
  and already fires an event.

---

## The four things Steam is not

### 1. It is a native app, and that is a runtime decision with one right answer

The game is a Node process (Colyseus, Express, `better-sqlite3`) plus a WebGL
client. Two shells are plausible and only one of them is cheap:

| | Electron | Tauri |
|---|---|---|
| The Node server | runs as-is | needs a second runtime bundled as a sidecar |
| `better-sqlite3` | a native module, rebuilt per platform — a solved, boring problem | still native, still rebuilt, now for a runtime you also ship |
| The renderer | Chromium/ANGLE — the exact GPU path every frame of this game has ever been drawn on | WKWebView on macOS, WebView2 on Windows: two engines, neither of them one three.js has been tested against here |
| Size | ~150–250MB installed | ~30MB plus the sidecar |

**Electron.** The size argument is the only one Tauri wins and it is worth
nothing on Steam, where a 5MB game and a 500MB game are the same download
button. The renderer argument is the one that decides it: switching web engines
means re-testing every shadow, every welded mesh and every `alpha` part on a
stack nobody here has ever rendered on, and finding out on somebody's MacBook.

Two consequences fall straight out of choosing it, and both are free:

- **Load the window from the local server, not from `file://`.** If the
  BrowserWindow opens `http://127.0.0.1:<port>/`, then `client/net.js` works
  **unchanged** — `location.hostname`, `location.port`, the `/api` fetch and the
  screenshot upload all keep meaning what they mean today. Point it at a file
  instead and every one of those needs a special case.
- **The MCP server needs no second Node.** Electron runs as plain Node when
  `ELECTRON_RUN_AS_NODE=1` is set, so the command the Modding panel prints is
  the game's own executable with that env var and `mcp/server.js`. One binary,
  not two, and it works the same on both platforms.

### 2. The server must stop being a server anybody can find

Three lines in `server/index.js` are dev conveniences that become bugs the first
time two people who are not us run this:

- **`PORT = 2567`, hardcoded.** Two copies of the game, or the game and a dev
  server, and the second one fails to boot. Bind port **0**, let the OS pick,
  hand the number to the window when you open the URL.
- **It listens on every interface.** On Windows the first launch pops the
  Defender firewall dialog — a security prompt, before the main menu, in a game
  about a shop. Bind **127.0.0.1** and it never appears. (Which then also means
  LAN play does not work by accident, and co-op has to be deliberate. See below;
  that is the right way round.)
- **`devMode: DEV`.** `NODE_ENV` is not `production` unless somebody sets it, so
  a packaged build turns on Colyseus devMode and tries to write `.devmode.json`
  into the process's working directory — Program Files, or `/`. It fails
  silently or writes somewhere an update wipes. CLAUDE.md already records that
  devMode has never once restored anything here; packaged, it is pure downside.

`DATA_DIR` is shipping.md step 1 and unchanged by any of this: per-user path
(`app.getPath('userData')`) handed to the server as `SNS_DB`.

### 3. Steam Cloud and SQLite WAL disagree

CLAUDE.md already has this trap written down for `cp`:

> Copying `data/game.db` with `cp` silently copies a stale shop. SQLite is in WAL
> mode, so recent writes live in `game.db-wal` until a checkpoint.

Steam Auto-Cloud is `cp` with a file glob, run at process exit, against a
machine that may have been powered off mid-write. Ship it naively and the
gotcha the repo has already paid for once happens to players instead: a shop
that syncs to the other computer three days behind itself, and nothing anywhere
says why.

Two ways out, and they are not equivalent:

- **Checkpoint on quit** (`PRAGMA wal_checkpoint(TRUNCATE)`) and sync `game.db`
  alone. Correct as long as quit is orderly. A hard kill leaves a `-wal` that
  never syncs, and the cloud copy silently misses the last session.
- **Sync all three files** (`game.db`, `-wal`, `-shm`) as one set. Right up
  until the cloud restores a mismatched trio, which is worse than stale.

Do the first, and add the checkpoint to the same quit path that calls
`persist()`. And note what the file *is*: content and save are one database, so
a player's mods ride along with their shop — a feature, and also the reason a
cloud conflict is not "you lost a day", it is "you lost the twelve crops you
authored". **Cloud is not required for launch.** Shipping v1 without it is
defensible; shipping it wrong is not.

### 4. The model path comes out, and we already wrote the thing that replaces it

**The shipped director is `inventEvent`, and the LLM is the part that goes.**
That is a decision, not a concession, and the order those two are written in
here matters — for as long as the API call is described as "the director" and
the local one as "the fallback", somebody down the line reads the packaged game
as the degraded version of itself. It is not. It is the game.

Look at what is actually in [`server/director.js`](../server/director.js): a
driver tag drawn from the season, filtered to tags something in the shop's
catalogue actually carries; allies that ride along and a rival that takes the
other side of it; multipliers rolled in bands; a duration; a headline from a
template; a no-repeat guard over the last three drivers, because a small pool
deals the same story three days running. Beside it, authored `events` rows drawn
a quarter of the time — the garnish, for a set piece somebody wrote on purpose.
That is a world-event system. What the model was buying on top of it was
*phrasing*, at the cost of a network call and a bill.

So the packaged build has no model in it at all, and three things fall out:

- **The AI question on Valve's content survey is simply "no".** Nothing a player
  reads is generated at runtime by a model, so there is no Live-Generated
  disclosure, no guardrail to write against illegal output, and no in-overlay
  report button pointed at us. That is worth more than the phrasing was — since
  the January 2026 clarification the exemption covers *development* tools only,
  so a shipped bring-your-own-key field would have put us squarely in it, and
  "the player supplied the key" is not an out.
- **`@anthropic-ai/sdk` leaves the dependency list** for the packaged build. A
  dependency that ships is a dependency that gets asked about.
- **Nothing about dev changes.** `ANTHROPIC_API_KEY` still works here, still
  writes better headlines, and is still fire-and-forget. It is a thing the two
  of us run against our own shop, which is what it has always been.

The one thing to check before cutting it, because it is invisible either way:
`inventEvent` draws from `game.rng`, and `runDirector` is the async path that is
never awaited by the tick. Removing a *branch* that was never taken in a
keyless build cannot move a balance number — but confirm the removal does not
change how many times that stream is called on the path that IS taken, or two
`simulate` runs either side of the cut diverge for a reason nothing prints.

---

## Co-op is the one real fork

`scripts/tunnel.js` cannot ship. It spawns `cloudflared`, greps its stderr, and
prints a `trycloudflare.com` URL to a console nobody has — and quick tunnels are
an unmetered convenience for developers, not transport for a product. So the
Host/Join design in shipping.md steps 5–6 (mint a token, encode `{url, token}`
into a pasteable code) is written against a mechanism that has to go anyway.

Steam replaces the whole of it:

- **Steam Networking Sockets / SDR** does NAT traversal and relaying, free, with
  no infrastructure of yours in the path.
- **Invites are the overlay's**, and the friends list is the address book. No
  code to paste, no URL, nothing to leak.
- **The token problem evaporates.** shipping.md's "the invite code *is* the
  token" is a clever answer to a question Steam does not ask: only a peer your
  session accepted can send bytes at all, so there is no public `/api` surface
  to guard. `SNS_TOKEN` stays exactly what it is today — a dev thing for a
  tunnel — and `OPEN_ROUTES` never has to shrink.

What it costs is a **transport shim**: Colyseus speaks WebSocket, Steam speaks
datagrams to a SteamID, and something has to sit between them — a custom
Colyseus transport on the host, and on the guest a client that hands
`colyseus.js` a duplex it can talk over. That is real work, in the one part of
the stack that has no test harness.

Which makes the honest sequencing:

- **v1 ships single-player.** Everything above is required regardless; none of
  it is co-op. The store page does not have to say co-op, and a game that says
  co-op and does it badly on launch weekend is worse than one that adds it.
- **Co-op is the first patch**, over Steam sockets, with the guest's identity
  being their SteamID — which slots into `who` exactly where local storage sits
  today, and gets you the player's actual name for free.

The alternative — ship co-op at launch over Steam sockets — is defensible if
two-player is the pitch. What is not defensible is shipping the tunnel.

---

## Achievements, nearly free, with one trap

43 rows in `goals.js`, each already firing an `achieved` message that stops the
world and shows a card. Map them one-to-one to Steam achievement API names and
the feature is a `SetAchievement` call.

The trap is *where* you hook it. **Not in `Game`** — `simulate` builds a real
`Game` in this same process, and a balance run would hand out a month's
achievements in a second and a half. CLAUDE.md already records that sweeps have
to call `silenceMilestones` for exactly this reason. Hook the **room's
broadcast**, which only a live world sends, and the headless paths cannot reach
it by construction.

Second, smaller: in co-op both people are playing one shop, so both unlock. That
is correct — it is one shop, and the guest owning nothing is the design.

Third: an achievement list and the ladder it mirrors are two lists that drift.
Same class of bug as the hand-typed credits screen, same fix — derive the
mapping from `GOALS` and assert the two agree (see *Verifying it*).

---

## What Steam wants that is not code

Nothing here is hard; all of it takes calendar time, and some of it takes weeks
you cannot compress.

| | |
|---|---|
| **Steamworks account** | Company/individual details, tax interview (W-8/W-9), bank details. Do this first; payment verification is the step that stalls. |
| **Steam Direct fee** | $100 USD per app, recoupable against revenue. Paid before you get an appid. |
| **The appid** | Everything below hangs off it. Also the moment to have settled the name — the repo says `sprout-and-stock`, the game says *Sprocket & Stock*. Pick one, and search it against existing Steam titles and trademarks before paying. |
| **Store page** | Header and library capsules at several sizes, at least five screenshots, a short and long description, tags, and realistically a trailer. There is a mandatory waiting period between the store page going live and release — budget a month of *wall clock* here, not a month of work. |
| **Content survey** | Age rating questions, and the AI disclosure discussed above. |
| **Depots** | One per platform: a Windows depot and a macOS depot, each with its own launch option. A Linux depot is nearly free from an Electron build and is what makes the Deck work — worth doing even if you never mention it. |
| **Uploading** | SteamPipe (`steamcmd` + a build script per depot). Steam is your updater: turn off any Electron auto-updater. Builds are reviewed before first release. |
| **macOS signing** | Apple Developer Program ($99/yr), a Developer ID cert, and **notarization is mandatory** for new macOS apps on Steam. Build and notarize on a Mac. Ship a universal binary — arm64 is the machine people actually have, and Rosetta is not something to plan around. |
| **Windows signing** | Not required by Steam, and Steam-launched executables largely dodge SmartScreen. Skippable for v1; a code-signing cert now means a hardware token or cloud HSM. |
| **Third-party licences** | Electron, Chromium, three.js, Colyseus, better-sqlite3, zod and friends all carry attribution clauses that a distributed binary triggers. The Credits tab already exists and is generated from a manifest — extend the manifest, do not type a list. |

---

## What must not happen

- **The packaged app must not write inside its own install directory.** Steam
  replaces that directory on every update. A save there is a save deleted by a
  patch, and it will not look like the patch's fault.
- **A Steam update must not overwrite authored content.** shipping.md says this
  and Steam sharpens it: the patch ships new `data/seed/*.json`, the player's
  content lives in `userData`, and the merge on boot is what carries new items
  in without reverting anybody's tomato. Insert what is missing, leave what
  exists alone.
- **A balance run must never unlock an achievement.** See above.
- **The firewall dialog must not appear.** If a player sees it, the answer is
  that something is bound wider than loopback, not that the dialog needs
  explaining.
- **No model call may be reachable from a shipped build.** Not behind a
  settings field, not behind a key the player supplies. The moment one is, the
  survey answer changes and a guardrail becomes something we owe Valve — for
  phrasing, on top of a generator we already wrote.
- **Cloud must not sync a `.db` without its WAL.** Either checkpoint or do not
  sync at all.
- **The tunnel must not ship.** Not as a fallback, not as an advanced option.

---

## Steps

Ordered so each one is testable, and so the first four are worth doing even if
Steam never happens.

1. **Data dir.** `SNS_DB` at `app.getPath('userData')`, first-run seed copy.
   (= shipping.md step 1.)
2. **Loopback, ephemeral port, production mode.** Bind 127.0.0.1:0, pass the
   port to the window, `NODE_ENV=production` so devMode is off.
3. **Quit is a save.** One path that calls `persist()`, checkpoints the WAL and
   then exits — wired to window close, `before-quit`, and whatever Steam does on
   "Stop".
4. **Merge-on-update seeding.** Insert missing rows, never overwrite. Needed the
   first time you patch, which is sooner than you think.
5. **Electron shell.** Window, fullscreen, icons, `better-sqlite3` rebuilt for
   both platforms, server as a child process so its crash is not the window's.
6. **Achievements.** Derived from `GOALS`, hooked to the room broadcast.
7. **Model path cut.** `inventEvent` and the authored rows are the director;
   the API call and `@anthropic-ai/sdk` are out of the packaged build.
8. **Modding panel.** The `ELECTRON_RUN_AS_NODE` command, the tag vocabulary,
   where the database lives. (= shipping.md step 7, minus the token.)
9. **Package + upload.** electron-builder, notarization on macOS, two depots,
   SteamPipe, a build that installs from Steam and runs on a machine that has
   never had Node on it.
10. **Store.** Fee, page, capsules, survey, review, the waiting period.
11. **Co-op over Steam sockets.** The transport shim, overlay invites, SteamID
    as `who`. First patch, not launch.

Steps 1–4 are ordinary bugs and ordinary features. 5–9 are the port. 10 is
calendar. 11 is the one with genuine unknowns in it, which is exactly why it is
last.

---

## Verifying it

`simulate` has nothing to say about any of this, and the ten-seed ritual does
not apply — but three claims here are the kind this repo writes sweeps for,
because each is invisible in a screenshot and each fails silently.

**Nothing is written inside the bundle.** Stamp the install directory, play a
session, stamp it again. A single changed byte is a save a patch will delete. A
sweep can do it; a person will not remember to.

**Every milestone has an achievement and every achievement has a milestone.**
Two lists that must agree, derived rather than kept — the credits-manifest
argument, applied to a thing Valve will not let you fix quietly after launch,
because an achievement removed from a live game takes it off people's profiles.

**No headless path can unlock anything.** Run `simulate`, run the verify suite,
and assert the Steam call was never reached. The failure is a shop nobody was
standing in awarding somebody a month of trophies, and there is no way to take
them back.

The rest is a manual list, and it should be written as one rather than pretended
into automation: install from Steam on a clean Windows machine and a clean Mac,
with no Node, no firewall exception and no dev tools, and play a day.
