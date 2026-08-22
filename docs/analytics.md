# Analytics — how many people are playing, and for how long

Status: **built**, and off until `VITE_SNS_GA` is set. One file
([client/analytics.js](../client/analytics.js)), three call sites in
[client/main.js](../client/main.js), no server, no new dependency.

The question this exists to answer is the small one: *is anybody playing this,
and do they stay*. Not funnels, not cohorts, not heatmaps. Everything below is
sized to that and should stay that way — the moment it needs a dashboard of its
own it has become a second product.

---

## Why GA4 and not one of the others

Four freebies were on the table.

- **Cloudflare Web Analytics** — free, unlimited, already on the same Pages
  project, and it needs no consent banner because it writes nothing to the
  browser. It counts visits and page views and *nothing else*: no custom events,
  no session length. A single-page game is one page view however long somebody
  plays, so it cannot answer either half of the question.
- **PostHog** free tier — 1M events a month and genuinely better product
  analytics (retention curves, "how far did they get"). Rejected on weight
  rather than on capability: it is a much larger script on a page that already
  ships a megabyte of three.js, and the depth it buys is depth nobody is asking
  for yet.
- **A first-party beacon** on the broker Worker, writing to D1. The only option
  no ad blocker can touch, and therefore the only one whose numbers are *exact*.
  Rejected because it has no dashboard — the work is not the endpoint, it is the
  stats page you have to build and then keep, and that is a bigger project than
  the thing being measured.
- **GA4** — free, unlimited at this scale, and average engagement time is
  literally the number being asked for.

GA4 wins on being the cheapest thing that answers the question. What it costs is
in *What it cannot tell you* below, and that section is the honest half of this
document.

---

## The shape

`VITE_SNS_GA` unset means **no script is fetched, no cookie is written, and
nothing is sent**. That is not caution, it is what keeps the numbers usable: a
dev server and a tunnel handed to one person for ten minutes are the two
sessions where somebody plays for an hour on purpose, and both would otherwise
land in the same property as the strangers.

It is also literally absent rather than merely inert. `import.meta.env` folds at
build time, so `if (ID)` is dead code in a build with no id and Rollup drops the
whole block — `npm run build:web` with the variable unset produces a bundle with
no occurrence of `googletagmanager` in it at all. Worth knowing before assuming
a grep of `dist-web/` proves anything either way.

### Turning it on

1. Make a GA4 property at <https://analytics.google.com>, add a **Web** data
   stream for `sprocket.willbowman.dev`, and copy the measurement id — it looks
   like `G-XXXXXXXXXX`.
2. Put it in the repo-root `.env` (which is gitignored, and which `vite.config.js`
   points `envDir` at — beside `client/` is the wrong place and fails silently):

   ```
   VITE_SNS_GA=G-XXXXXXXXXX
   ```
3. `npm run deploy`.

The id is baked in at build time, so **it only takes effect on a rebuild**, and
a build made on a machine without that `.env` reports nothing. That is the same
trap `VITE_SNS_BROKER` has and the reason the broker carries a literal default
instead — this one deliberately does not, because a fork of this game should not
silently report to somebody else's property.

---

## What is sent

Three events on top of what GA4 does by itself.

| Event | When | Params |
|---|---|---|
| `shop_open` | a shop is up and playable | `mode`: `own` or `guest` |
| `play_tick` | every 60s while the tab is **in front** | `minutes`: running total this session |
| `milestone` | a rung of the ladder is awarded | `milestone_id` |

And automatically, from gtag itself: users, new vs returning, sessions,
engagement time, country, device, browser, referrer.

Three decisions in there are worth knowing.

**`play_tick` exists because GA4's own session would otherwise be cut up.** A
session ends after 30 minutes with no events on it, and somebody watching their
shop trade sends no events at all — so the one number being asked for is exactly
the one that would come back wrong, and it would come back wrong in the flattering
direction that is hardest to notice: lots of short sessions rather than one long
one. A minute is far inside the window and costs 60 events an hour, which is
nothing against a free tier.

**It is gated on `document.visibilityState`.** A game left open in a background
tab is not somebody playing, and counting it turns "how long do people play" into
"how long do people leave a tab open" — different question, wildly different
answer. Browsers throttle a background interval to roughly this period anyway, so
the check is what makes the measurement honest rather than what makes it cheap.

**`mode` is the only way co-op is visible at all.** A guest never opens a world
of their own, so they touch no save, mint no world row and appear in nothing else
the game records. Without this parameter, somebody else's shop is a session that
looks identical to a solo one.

**There is no `user_id`.** The game already mints a stable per-browser id
(`sns-me`, see `whoAmI` in [client/net.js](../client/net.js)) and it was
deliberately not wired in: GA4's own client id is also per-browser, so handing it
a second one buys nothing at all and puts an identifier the game uses for *save
ownership* into a third party. If cross-device identity is ever wanted, that
needs an account, and an account is not this document.

### Reading it back

Custom parameters do not appear in GA4 reports until they are registered.
**Admin → Custom definitions**, and add three:

- `mode` — custom **dimension**, event-scoped
- `milestone_id` — custom **dimension**, event-scoped
- `minutes` — custom **metric**, event-scoped, unit *Standard*

Skipping this is the single most common way to conclude the events are not
arriving. They are; the reports are just refusing to break down by anything they
have not been told about. Realtime shows them immediately either way, which is
the fastest check that a deploy is reporting.

For playtime, the number to look at is **Reports → Engagement → average
engagement time per active user**. `play_tick`'s `minutes` is the cross-check and
the distribution — the average hides the difference between everybody playing 20
minutes and most people bouncing while three people play all afternoon, which for
a game is the only interesting part.

---

## What it cannot tell you

- **Roughly a third of your players are missing.** Ad blockers block
  `googletagmanager.com` by default, and this game's audience is exactly the
  audience that runs them. Everything here is a *floor*, not a count, and it is a
  biased floor — the blocked third are the more technical players, so anything
  that varies with how technical somebody is will read wrong. Treat the trend as
  real and the absolute number as an undercount.
- **Nothing about the shop itself.** No takings, no day reached, no what-was-built.
  The sim knows all of it and none of it is sent, because it is a shape of data
  that wants a database rather than an event stream. If that becomes the question,
  the first-party beacon above is the design to reach for, not more GA events.
- **A guest's session is measured on the guest's own tab.** Their play time is
  theirs; the host does not report it, and the two are separate sessions in the
  same property told apart only by `mode`.

## Consent

Built, as **Google Consent Mode v2** plus a switch in the Menu.

An untouched browser is *granted* outside the EEA and *denied* inside it, and
the moment somebody actually works the switch what they said wins in both
directions — so turning it off in Ohio sticks and turning it on in Berlin
sticks. Three states, and the third one is the whole design: "has not said" is
not the same as "said no", and only the first of those is allowed to vary by
where somebody is.

Denied does not mean the tag is absent. It means gtag sends **cookieless
pings**: no identifier is stored, nothing is written to the browser, and what
comes back is modelled counts rather than people. That is the trade this was
chosen for, and it is worth being clear that it *is* a trade — see below.

### Where the switch is

The Menu (`/`), in the switch grid beside Tutorial and Sound —
`switchGrid` in [client/sections.js](../client/sections.js).

It **only appears in a build that has somewhere to send them**. A privacy switch
in front of somebody whose game reports nothing is the "tier that changes no
number" trap wearing a privacy setting, and it is the worse form of it: what it
takes is not money but a promise about them.

It takes effect on the press, not on the next load. `consent`/`update` is a
message to a tag that is already running, so somebody who turns it off stops
being tracked from that moment and somebody who turns it on does not have to be
told to reload.

### Two things in the implementation that are easy to get wrong

**The `consent` default must be the first call on the queue**, before `js` and
before `config`. Later, and the tag has already decided what it may store by the
time it is told — which is the one way to get this wrong that *still reports
numbers*, so nothing looks broken and the cookie is written anyway.

**The three ad fields are declared and hardcoded denied.** This game runs no ads
and has nothing to remarket, so they are not a decision to put in front of a
player — but Consent Mode v2 requires them to be declared, and an omitted field
is not a denied one.

### Where somebody is, without asking anybody

`mustAsk` reads the browser's own timezone (`Intl.DateTimeFormat`). No IP
lookup, which would mean telling a third party about somebody in order to decide
whether they may be told about, and no server, which this build does not have.

It is approximate and **the inaccuracy is one-sided on purpose**: `Europe/` also
catches Moscow, Istanbul and Kyiv, none of which are the EEA. Over-including
costs those players a switch they can turn on; under-including would be the only
mistake here that matters. `STRAYS` is the short list of EEA zones a `Europe/`
prefix misses — Iceland, the Atlantic islands that are Spain and Portugal, and
both halves of Cyprus. A browser that will not report a timezone at all is
treated as needing asking.

### What is still true after all that

**A switch in a menu is not a banner, and a strict reading of GDPR wants the
affirmative act before the third-party script loads at all.** What is built here
is the industry-standard reading rather than the strictest one: denied-by-default
cookieless pings, an easy and equally-weighted way to change it, and no
identifier stored for anyone who has not said yes. That is a defensible position
and it is not the *safest* one, and the difference is worth knowing rather than
discovering.

The strictest version is one line — do not inject the script at all unless
`statsOn()` — and it costs the EEA numbers entirely. If this ever grows an
audience big enough for the question to be worth money, that line is the change,
and [client/analytics.js](../client/analytics.js) is the only file it touches.

### What a build with no id ships

Nothing that talks to Google. With `VITE_SNS_GA` unset, `npm run build:web`
produces a bundle with **no occurrence of `googletagmanager` and no
`dataLayer`** — `import.meta.env` folds at build time, so the whole block is
dead code and Rollup drops it.

What does survive is the *reading* half — the `sns-stats` key and the timezone
list, a few hundred bytes — because `statsOn` is exported and the Menu calls it.
Nothing writes and nothing sends, and the tile does not render. Worth knowing
before concluding from a grep that either half is or is not there.
