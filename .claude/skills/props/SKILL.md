---
name: props
description: Design or update fixture art in Sprocket & Stock — shelves, machines, conveyor pieces, decorations, pens. Covers the one check that must come first (is this piece drawn from its row or in code?), the luminance floor the ink pass needs, tile and part-count bounds, how to avoid z-fighting, and the assert-before-POST loop. Invoke whenever changing how a fixture LOOKS.
---

# Changing how a fixture looks

## 0. FIRST: does this piece read its row at all?

Some pieces are drawn in **code** and ignore their `fixtures` row entirely. A
`lift` has a row with a model, tiers, a price and a name, and the renderer never
opens the model — the shaft is built from `ELEVATOR_*` geometry in
`client/render/scene.js` wearing `CONVEYOR.*` from `client/render/palette.js`.

Authoring colour onto that row is a write that succeeds, a model that validates,
a `content_version` that bumps, a client that reloads, and a piece that does not
move one shade. **Every signal says it worked.**

```bash
grep -rn "<kind>" client/render/scene.js | grep -iE "GEO|_H =|_W =|OWNERS|Mesh"
```

If that returns geometry constants, the art lives in code — edit `palette.js`
(colour) or `scene.js` (shape), not the row. `ELEVATOR_OWNERS` in `scene.js`
names the pieces on that path.

**The tell:** the drawn thing has features the row does not. Windows, a bezel, a
chamfer that appears in no `parts` entry means you are not looking at the row.
Check that *before* the second recolour, not after the fourth.

## 1. Colour — the ink needs somewhere to land

The contour pass lays a near-black line. A surface darker than the line has
nothing to lay on, so it draws **no line at all** — not a faint one.

| linear luminance | what the ink does |
|---|---|
| 0.20+ | works, 60–100/255 contrast |
| 0.10–0.20 | weak |
| under 0.10 | effectively nothing |

Rules that follow:

- **Structure sits at 0.6–0.7.** The biggest parts are the pale ones.
- **Dark is an accent on small parts only.** A piece that is 50% dark by surface
  area is a piece the contour cannot describe.
- **Never judge by albedo alone** — check the ratio of dark *surface area* to
  total, not the count of dark colours.

`INK.LIFT` in `look.js` rescues genuinely near-black by flipping the line
*lighter* than the surface. That is a highlight, not an ink, and will never key
with the rest of the shop. It is not a substitute for art with headroom.

### The reference palette

Derived on the `packer`, and the one to reach for on any machine:

```
#d7dfe8  0.73   structure — posts, decks, frames, rims
#c8d0da  0.62   secondary — rails, cills, heads
#d6e9f4  a0.22  glass
#83909f  0.27   mid — bodies, under-deck
#6f7d92  0.20   dark accent — small members only
#3b424e  0.05   recesses and throats — a hole that is not dark is a decal
#5f8ba6  0.25   band blue
#3f9fb0 / #4fb3c4 / #63cddd   tier accent, steps with the rung
```

Snap an existing piece onto it **by surface area**, not by luminance: rank the
colours by area, biggest gets `#d7dfe8`, and the dark ones can only land on the
smallest. Ranking by luminance preserves how dark the piece already was, which
is the thing being fixed.

## 2. What actually makes the ink read

Two detectors, and they are not equal:

- **Silhouette** (depth) — strong. Fires on real depth steps. This is why
  crates, rails and small separate objects read beautifully.
- **Crease** (normals) — hair-fine by design (`CREASE_WIDTH` 0.2 in a half-res
  buffer). Big slabs packed together have only crease detail, so they read flat.

So a big machine needs **relief, not decoration**:

- Panel lips of 0.03 are invisible. Aim for **0.08+** depth change.
- The footprint is one tile, so relief is cut **inward** — pull a face back and
  leave a frame standing at the edge. Raising past ±0.5 fouls the neighbour.
- Open a face up and glaze it rather than adding surface detail. You see the
  guts, which is depth the contour can find.

Do **not** lower `CREASE_THRESH` to catch shallow edges. 0.32 was tried: it
catches the half-res normal buffer's own quantisation first, so flat walls come
back **stippled** — a dashed line up a surface with no edge on it. It reads as
clipping, and it wrecks the big flat things first. `CREASE_INK` is the safe
crease dial; it adds no edges, only darkens lines that already qualified.

## 3. Hard bounds

- `MAX_PARTS` is **36** per stage (`shared/schemas.js`).
- Everything within **x, z ∈ [-0.49, 0.49]**. At ±0.5 you are on the tile
  boundary and will fight the neighbouring cell.
- Nothing below **y 0.03**. The ground plane, belt mats and their chevrons draw
  there — a part reaching y 0 dithers against them. This bit both the `packer`'s
  feet and the `lift`'s posts.
- Parts of different colours must not share a **coplanar face**. Make things
  proud by 0.03+ and inset by 0.04+ from the face they sit on. Where two proud
  members cross, give one clearly more proudness than the other.

## 4. Writing it

`create_fixture` over MCP rejects any `model` (the param is untyped). POST the
control API directly:

```python
urllib.request.Request('http://localhost:2567/api/content/fixture',
    data=json.dumps(row).encode(),
    headers={'Content-Type':'application/json'}, method='POST')
```

Fetch current state first: `curl -s localhost:2567/api/content/fixture`.

**Rebuild the whole model in one script rather than patching by index.**
Successive index-based edits against a model whose indices have shifted silently
write to the wrong parts. That produced members poking outside the tile and
glass buried inside solid geometry, neither visible in the diff.

**Assert before POSTing.** Every time:

```python
def box(q): return [(q['pos'][i]-q['scale'][i]/2, q['pos'][i]+q['scale'][i]/2) for i in range(3)]
assert len(parts) <= 36
for i, q in enumerate(parts):
    b = box(q)
    assert -0.49 <= b[0][0] and b[0][1] <= 0.49, (i, 'x', b[0])
    assert -0.49 <= b[2][0] and b[2][1] <= 0.49, (i, 'z', b[2])
    assert b[1][0] >= 0.029, (i, 'y off the mat', b[1])
assert {q['color'] for q in parts} <= PALETTE
```

A piece with stages: build every stage from one function, varying only the tier
accent. Only that one part should differ between rungs.

## 5. Afterwards

- **Hand it to Will to look at.** Do not judge art from a screenshot yourself.
- `npm run verify:look` if `look.js` or `palette.js` moved.
- `npm run export` before committing, or the content lives only in the local DB
  and the other person never sees it.
- Adding parts is free of balance impact; a *variant* is a look and a *tier* is
  a number. If a shape should change what a fixture does, that is a kind, not
  art — see `shared/build.js`.