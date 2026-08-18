# ⚙️ Sprocket & Stock

A cozy shop-and-farm sim where you are the only human on the payroll — and a
game you and someone else build **while playing it**.

You buy the robots, you set what each one cares about, and they grow the crops
out back, fill the shelves out front and work the queue. Get the dials wrong and
they'll spend the day politely doing the wrong job. Meanwhile an AI director
decides what the town is doing today — a heat wave, a viral snack, a supply
shortage — and the shop has to react.

Everyone who works here is a machine. Everyone who shops here, mostly, isn't.

The point isn't only the game. It's that two people, on two machines, each with
their own coding agent, can change the same running world at the same time
without ever hitting a merge conflict.

---

## Quick start

Needs [Node.js 20+](https://nodejs.org). Works the same on macOS and Windows.

```bash
git clone <your repo url> sprout-and-stock
cd sprout-and-stock
npm install
npm run seed     # load the starter items, crops and customers
npm run dev
```

Open **http://localhost:5173**.

`WASD` or drag to move · **click & hold** to use things · `Q` seed wheel ·
`B` supplier · `U` upgrades · `G` build mode · `M` build menu

Walk up to something and it lights up with a gold ring, and the bar at the
bottom tells you what holding would do — "Click & hold to Harvest". Press and
hold to commit; a ring fills, and letting go before it's full cancels. Nothing
ever happens just because you stood near it.

To farm: walk to a plot and hold to turn the soil, pick a seed off the wheel
(`Q`) and hold to sow, then hold again once it's grown to harvest. Carry it
inside and hold at a shelf to stock it. Hands full of the wrong thing? Take it
out to the loading bay and hold to put it back in a crate.

`G` opens build mode, where you buy and place shelves, freezers, tills and
plots yourself — tap a tile to place, `R` to rotate, and use the Move and Clear
tools to rearrange or tear out what's already there.

---

## Playing together

One machine hosts. On that machine:

```bash
npm run tunnel
```

It prints a public URL. The other person opens it — that's it, no install on
their side. The same URL also serves the control API, so **their agent can
drive the game too** (see MCP setup below).

To keep the control surface private, set a shared secret first:

```bash
# macOS / Linux
SNS_TOKEN=some-shared-secret npm run tunnel

# Windows PowerShell
$env:SNS_TOKEN="some-shared-secret"; npm run tunnel
```

---

## Building it together (the actual point)

Add this to `.mcp.json` in the project (already included) or to your Claude
Code MCP config. On the **host** machine it works as-is. On the **guest**
machine, set `SNS_API` to the tunnel URL:

```json
{
  "mcpServers": {
    "sprout-and-stock": {
      "command": "node",
      "args": ["mcp/server.js"],
      "env": {
        "SNS_API": "https://your-tunnel-url.trycloudflare.com/api",
        "SNS_TOKEN": "some-shared-secret"
      }
    }
  }
}
```

Now your agent can:

| Tool | What it does |
|---|---|
| `get_state` | Read the live shop — cash, shelves, customers, everything |
| `screenshot` | **See** the game (asks a real browser tab to render a PNG) |
| `simulate` | Fast-forward 100 in-game days headless and report whether the economy works |
| `create_item` / `create_crop` / `create_archetype` | Add content that appears in the running game in ~1 second |
| `stock_shop` | Fill shelves + plant fields so you can look at something |
| `spawn_customer` | Drop shoppers in now instead of waiting |
| `add_modifier` | Force a demand spike to test a tag |
| `regenerate_layout` | Rebuild the shop from a new seed |
| `list_tags` | The tag vocabulary — read this before creating anything |

Try asking your agent:

> *"Add three snacks a teenager would want, then simulate 30 days and tell me if
> they actually sell."*

> *"Screenshot the shop, then make the shelves look less like brown boxes."*

> *"Invent a customer type nothing on my shelves currently satisfies."*

---

## Why it doesn't conflict

Content — items, crops, customers, events, upgrades — lives in a **SQLite
database**, not in source files. Adding an item is an `INSERT`, validated on
the way in, live on the next tick. Two people adding content at the same time
simply cannot collide, and bad content is rejected with an explanation instead
of breaking anyone's game.

Code still lives in git, where it belongs.

`npm run export` dumps the live database back to `data/seed/*.json` so your
session's content becomes a reviewable commit:

```bash
npm run export && git add data/seed && git commit -m "new snacks"
```

---

## The AI director

Once per in-game day the world decides what it's doing, and expresses it as
multipliers on **tags** rather than on specific items — so an event written
today still works on an item invented next month.

```bash
# macOS / Linux
export ANTHROPIC_API_KEY=sk-ant-...

# Windows PowerShell
$env:ANTHROPIC_API_KEY="sk-ant-..."
```

**Without a key the game is fully playable** — it falls back to the
hand-written events in `data/seed/events.json`. The simulation never waits on
the API; if it's slow or down, the world just carries on with what it had.

---

## Deploying it so other people can play

The game server serves the built client, so it's a single Node process:

```bash
npm run build
NODE_ENV=production npm start
```

That runs everything on one port (`2567` by default, or `PORT`). Any host that
runs Node with a persistent disk works — Fly.io, Railway, a Raspberry Pi. The
only stateful thing is `data/game.db`; mount a volume for it and the shop
survives restarts.

---

## Commands

| | |
|---|---|
| `npm run dev` | Server + client with hot reload |
| `npm run tunnel` | Public URL for playing together |
| `npm run seed` | Load `data/seed/*.json` into the database |
| `npm run export` | Dump the database back to `data/seed/*.json` |
| `npm run reset` | Wipe the world and reseed |
| `npm run build` | Build the client for production |

Design notes and the working agreement between the two of you live in
[CLAUDE.md](./CLAUDE.md).
