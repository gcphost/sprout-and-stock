/**
 * THE CONTOUR AS A DRAWN LINE.
 *
 * The chrome borrows `INK.COLOR` from client/render/look.js so a button and a
 * shelf are outlined in the same colour — and for a while it borrowed nothing
 * else, which is why the HUD read as a form rather than as a drawing. A
 * `box-shadow` ring is perfectly even, perfectly geometric and identical on all
 * four sides, and no line a pen ever made is any of those. What the ink pass
 * has that a border cannot have is VARIATION: `INK.FADE` thins it with
 * distance, `INK.LIFT` moves it off a dark surface, and the sil pass draws it
 * off a depth buffer, so its weight changes along its own length.
 *
 * So the three big cards get a real stroke — an `<svg><rect>` pushed through
 * `feTurbulence` + `feDisplacementMap`, which wanders and thickens the way a
 * nib does. Everything else in the HUD keeps its box-shadow, and that is a
 * decision rather than a shortcut: at 40px a wobbling outline is not a drawn
 * line, it is a noisy one, and `INK.FADE` says a small object gets the plainer
 * mark anyway. Three elements, none of which is ever re-created:
 *
 *   #stats      the corner readout
 *   #build-bar  the palette
 *   #panel      every menu in the game
 *
 * THE RECT IS INSET, and that is the one number here that is load-bearing.
 * Two of the three hosts clip (`#stats` so `#sign` can be an EDGE of the card
 * rather than an object inside it; `#panel` so its sticky bars do not scroll
 * out past the corners), and both of those reasons are older and better than
 * this file. A stroke laid hard against the edge of a clipping box has half its
 * wander cut off — the line goes flat wherever it tried to leave, which reads
 * as a chewed line rather than a drawn one, and it would only do it on two of
 * the three. So the rect stands `INSET` in from the edge, further than the
 * displacement can reach, and it does it on ALL THREE so the margin is a
 * deliberate one rather than an artefact you can only see on the bar.
 *
 * `vector-effect: non-scaling-stroke` is what lets the viewBox be stretched to
 * whatever the card is: without it a 640px bar 80px tall draws its top and
 * bottom eight times heavier than its sides, which is a border pretending to be
 * a perspective. The filter is a CSS filter on the element, so the noise is in
 * screen pixels and does not stretch with it either.
 */

const NS = 'http://www.w3.org/2000/svg';

/* Where a host keeps its own `fit`. A Symbol on the ELEMENT rather than an
   entry in a Map, and that is the whole of why `inkScope` cannot leak: a map
   from element to callback is a strong reference to every card that has ever
   been drawn, held by the module, and `innerHTML =` does not clear it. Hung on
   the element, the callback is garbage the moment the element is. */
const FIT = Symbol('ink-fit');


/* TWO NIBS AND TWO SEEDS EACH.
 *
 * Two seeds because a single filter is one shape of wobble repeated on every
 * card on screen, which the eye reads as a texture — a repeated imperfection is
 * a pattern, and a pattern is the thing this exists to avoid. They alternate,
 * so the two corner widgets stacked in one column never wander in step.
 *
 * Two NIBS because the wander is in screen pixels and the cards are not one
 * size. 2.1px on a 640px bar is a line that breathes; the same 2.1px on a 146px
 * meter is a third of a corner, and what that reads as is a card somebody sat
 * on. This is `INK.FADE`'s argument said about width instead of distance — a
 * smaller object gets the plainer mark — and it is the same reason the 40px
 * rail buttons get no drawn line at all. */
/* ...and an INSET each, which is the number `INSET` above used to be alone.
 * It has to clear the filter's own `scale` or the wander is cut off, and that
 * is a floor rather than a value: 2.4 is right for the card nib (2.1) and is
 * nearly twice what the small one (1.2) needs.
 * On a 400px card the difference is invisible. On a 34px control it is a
 * TWELFTH OF THE HEIGHT, and what that draws is a rectangle floating inside
 * the button rather than a line round it — the fill carries on past its own
 * outline on all four sides, which reads as two boxes and is the one thing an
 * ink pass must never look like. `trim` is the same nib pulled in to the
 * smallest margin its own displacement allows, for slim controls that are
 * still wide enough to be worth drawing.
 * `small` keeps 2.4 deliberately: the HUD's three hosts on it are 70–186px and
 * have been looked at, and a nib table is not the place to restyle them. */
const NIBS = {
  card: { on: ['rough-a', 'rough-b'], inset: 2.4 },
  small: { on: ['rough-c', 'rough-d'], inset: 2.4 },
  trim: { on: ['rough-c', 'rough-d'], inset: 1.4 },
};

/**
 * Hang a drawn contour inside `el`. `z` is the host's own stacking answer —
 * the line goes OVER the contents rather than under them, which is the whole
 * reason `#panel` grew an overlay in the first place: its header, tabs and
 * heads bleed full width, so a line drawn on the box itself is painted out for
 * 90px and the card appears to have a hole in its side.
 */
export function inkEdge(el, z, seed = 0, nib = 'card', obs = null) {
  if (!el) return;

  const { on, inset } = NIBS[nib] || NIBS.card;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ink-edge');
  svg.style.zIndex = z;
  svg.style.filter = `url(#${on[seed % on.length]})`;

  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', inset);
  rect.setAttribute('y', inset);
  svg.appendChild(rect);
  el.appendChild(svg);

  /* The viewBox is written in the card's OWN pixels rather than a fixed
     `0 0 100 100`, or the inset is 2.4 units of a stretched box — which on a
     640x80 bar is 15px along the top and 1.9px down the side, and the line
     stops being parallel to anything. */
  const fit = () => {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    rect.setAttribute('width', Math.max(0, w - inset * 2));
    rect.setAttribute('height', Math.max(0, h - inset * 2));
    /* ...and the corner is READ off the host rather than written here, which it
       was (`rx: 2`, the old universal `--r`). Three cards share this file and
       they no longer share a radius: the panel is rounded like a card in the
       game now and the two corner widgets are not, so a fixed rx draws a square
       corner inside a round one — a stroke that leaves the card and comes back,
       which reads as the outline being broken rather than as a number being
       wrong. Measured in `fit` and not once at build, because a stylesheet is
       the thing that decides it and the host may be restyled under us. */
    const r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    rect.setAttribute('rx', Math.max(2, r - inset));
  };

  fit();
  el[FIT] = fit;
  /* A ResizeObserver rather than a repaint on every `ui.update`: these three
     change size when a menu changes tab or the palette changes row, which is a
     handful of times a minute, against ten snapshots a second. Watching the
     size is watching the only thing this actually depends on.

     `obs` is a SHARED observer handed in by `inkScope`, for hosts that are
     thrown away and made again. The `window` fallback is the one branch that
     must never be reached from there — an element gone from the document
     cannot be un-listened, so a resize handler per card per rebuild is a leak
     that grows with how often you press anything. A scope passes an observer or
     accepts a line that is laid once and never re-measured. */
  if (obs) obs.observe(el);
  else if (window.ResizeObserver) new ResizeObserver(fit).observe(el);
  else window.addEventListener('resize', fit);
}

/**
 * A pass over hosts that DO NOT survive — the front door, where `Menu.render`
 * rebuilds `.menu-box` from `innerHTML` and every card, field and button in it
 * is a new element. The five in `inkEdges` are static containers and can be
 * inked once at boot; nothing on that screen can.
 *
 * The leak this exists to not be is countable rather than a worry. Per redraw
 * the old cards are dropped by `innerHTML` and the new ones are inked, so the
 * things that could accumulate are (a) observers, (b) observations and (c)
 * closures the module still points at. There is ONE observer for the whole
 * screen, made once with the scope. `clear()` disconnects it, which drops every
 * observation in one call — and it is called at the top of the redraw, BEFORE
 * the markup is replaced, so the set never contains an element that has left
 * the document. And nothing is held in the module: `fit` lives on its own host
 * under `FIT`, so a card that goes takes its callback with it.
 *
 * The `<svg>` and its `<rect>` are children of the host and die with it. No
 * filter is created — `rough-a`…`rough-d` are authored once in index.html and
 * referenced by url, which is why a screen full of drawn lines costs four
 * filters however many cards are on it.
 */
export function inkScope() {
  const obs = window.ResizeObserver
    ? new ResizeObserver((entries) => { for (const e of entries) e.target[FIT]?.(); })
    : null;
  return {
    edge: (el, z, seed = 0, nib = 'card') => inkEdge(el, z, seed, nib, obs),
    /* Also safe to call before anything has been drawn, which is what lets the
       redraw open with it unconditionally rather than tracking whether it is
       the first one. */
    clear: () => obs?.disconnect(),
  };
}

/**
 * All five, once, at boot. They are static containers in index.html — their
 * CHILDREN are rewritten (`#panel-body` from `innerHTML` on every menu,
 * `#build-strip` on every palette rebuild, `#rci`'s rows ten times a second)
 * and the containers themselves never are, which is what makes one call at
 * startup enough. That is also why the line goes on `#rci` rather than inside
 * it: anything sharing an element with those bars lives about a tenth of a
 * second.
 *
 * The two corner widgets keep the split their own rules already make — the
 * FILL recedes to `--panel-dim` until you point at one and the LINE does not,
 * because a contour dropped to 45% is a soft grey border, which is the one
 * thing an ink pass is not. A drawn stroke is a child rather than the
 * element's own shadow, so it sits out the `background` transition for free.
 */
export function inkEdges() {
  inkEdge(document.getElementById('stats'), 2, 0);
  inkEdge(document.getElementById('build-bar'), 4, 1);
  inkEdge(document.getElementById('panel'), 5, 0);
  inkEdge(document.getElementById('rci'), 2, 0, 'small');
  inkEdge(document.getElementById('radio'), 2, 1, 'small');
  /* The shape card hangs off the top of the bar, over the world, so it is a
     floating object in its own right rather than a row inside one — and it is
     186px, which is the small nib's width rather than the bar's. The other
     seed, because it is drawn touching the bar and two identical wobbles
     meeting at an edge is the pattern this is all trying not to be. */
  inkEdge(document.getElementById('build-shapes'), 6, 0, 'small');
}
