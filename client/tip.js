/**
 * The tooltip.
 *
 * Every hover explanation in this game has been a native `title` until now,
 * which has three problems and only the first is cosmetic. It looks like an
 * operating system rather than like the shop. It appears wherever the pointer
 * happens to be, about a second later, which on a 40px button in a row of eight
 * is nowhere near the thing it is about. And it can only ever be one run of
 * grey text — so a button carrying a name, a hotkey and a live delivery status
 * had to flatten all three into one line with a middle dot in it.
 *
 * This is one element, moved, rather than a node per hoverable thing. The rail
 * alone would be eight, the build bar forty, and every one of them would be a
 * child of something with `overflow` on it — which is the other half of why
 * this is `position: fixed` on the body rather than an `::after` on the button.
 *
 * Anything can ask for one explicitly:
 *
 *   data-tip       the headline — what the thing IS
 *   data-tip-key   a hotkey, drawn as a key cap on the right (optional)
 *   data-tip-note  a second line — what it is DOING, right now (optional)
 *   data-tip-tone  `good` or `warn`, which colours the note (optional)
 *
 * ...but a plain `title` gets one too, because the alternative was rewriting
 * every hover string in the game to opt in — twenty-five of them across six
 * files, all of which would then have to be kept in step by hand. `harvest`
 * moves a `title` onto those attributes the first time you hover it. That is
 * not only less work: it means a title written *tomorrow*, anywhere, is drawn
 * in the shop's handwriting without anybody having to know this module exists.
 *
 * Everything is written with `textContent`, so a note built out of an item
 * somebody named cannot put markup on screen.
 */

/**
 * What separates a name from its explanation in a `title`.
 *
 * The house convention already — `${name} — ${blurb}` is how the fixture menu,
 * the roster, the upgrade list and the palette all write one — so splitting on
 * it hands most of the game the two-line treatment for nothing. A title with no
 * dash in it is simply one line, which is what it always was.
 */
const SPLIT = ' — ';

/**
 * How long the pointer has to rest before a tip appears.
 *
 * The rail is eight buttons on a 46px pitch, so crossing it to reach the one
 * you want passes over four of them — with no delay that is four tooltips
 * firing and cancelling in about a third of a second, which reads as the HUD
 * glitching. Long enough to mean you stopped, short enough that it never feels
 * like waiting: a native title takes about a second and that is the thing this
 * is replacing.
 */
const SHOW_MS = 110;

/**
 * How far the box sits off the thing it describes.
 *
 * The caret eats about 5 of it — a 10px square turned 45° hangs its corner that
 * far below the box — so this is nearer to a 4px gap than a 9px one, which is
 * the point. A caret that stops well short of its button stops reading as a
 * caret and starts reading as a stray diamond.
 */
const GAP = 9;

/** Never nearer the edge of the screen than this. */
const MARGIN = 8;

class Tip {
  constructor() {
    this.el = null;
    this.target = null;
    this.timer = 0;
    this.wired = false;
  }

  /**
   * One set of listeners on the document rather than a set per element.
   *
   * Which is not only cheaper — it is the only thing that works. The rail, the
   * build bar and every menu in the game rebuild themselves out of `innerHTML`,
   * so a listener bound to a button is thrown away the next time its panel
   * redraws, and the tip would quietly stop appearing on exactly the surfaces
   * that update most.
   */
  install() {
    if (this.wired) return;
    this.wired = true;

    document.addEventListener('pointerover', (e) => {
      // A tip is a hover, and half of this game is played with a finger. On
      // touch, `pointerover` fires on the tap that also presses the button —
      // so a finger would get a tooltip explaining the thing it just did.
      if (e.pointerType && e.pointerType !== 'mouse') return;
      // A panel that redrew while you were reading one of its rows leaves the
      // tip describing a node that is no longer in the document. Checked here
      // rather than on a timer: the only way to find out it is stale is to
      // look, and the cheapest moment to look is one you are already handling.
      if (this.target && !this.target.isConnected) this.hide();
      const el = e.target?.closest?.('[data-tip], [title]') ?? null;
      // Moving between a button's own children is not leaving the button.
      if (el === this.target) return;
      this.hide();
      if (el) {
        this.target = el;
        this.timer = setTimeout(() => this.show(), SHOW_MS);
      }
    });

    document.addEventListener('pointerout', (e) => {
      if (!this.target) return;
      // Same test the other way round: `pointerout` fires when the pointer
      // crosses onto a child, and hiding there would flicker the tip off and
      // straight back on as you moved across the icon.
      if (this.target.contains(e.relatedTarget)) return;
      if (e.target?.closest?.('[data-tip], [title]') === this.target) this.hide();
    });

    // Anything that means you have stopped looking at it. A press especially:
    // the tip is above the button, so a tip left up after a click covers
    // whatever the click just opened.
    document.addEventListener('pointerdown', () => this.hide(), true);
    document.addEventListener('scroll', () => this.hide(), true);
    window.addEventListener('blur', () => this.hide());
  }

  /** Built once, on the first hover of the session, and then reused for ever. */
  ensure() {
    if (this.el) return;
    this.el = document.createElement('div');
    this.el.id = 'tip';
    this.el.setAttribute('role', 'tooltip');
    this.el.innerHTML = '<div class="row"><span class="ttl"></span><span class="key"></span></div>'
      + '<div class="note"></div><span class="arrow"></span>';
    document.body.appendChild(this.el);
  }

  /**
   * Turn a plain `title` into the attributes above, once, on first hover.
   *
   * The attribute is REMOVED rather than left alongside. The two do not stack:
   * a native tooltip would still surface a second later, underneath the drawn
   * one, saying the same thing in the operating system's handwriting.
   *
   * A `title` re-appearing on an element that already has `data-tip` is not a
   * mistake — a panel rebuilt from `innerHTML` writes a fresh one, and so does
   * anything that assigns `el.title` as its state changes (the shop's open and
   * pause buttons both do). So a live `title` always wins over what was
   * harvested last time, or those two would freeze on whatever they said the
   * first time you happened to point at them.
   */
  harvest(el) {
    const raw = el.getAttribute?.('title');
    if (raw == null) return;
    el.removeAttribute('title');
    const text = raw.trim();
    if (!text) return;

    // `title` is an accessible name as well as a tooltip, and taking it away
    // would silently un-label every icon-only button in the game. Only where
    // there is nothing else naming the thing: on a button that has its own
    // words, an `aria-label` would override them rather than add to them.
    if (!el.getAttribute('aria-label') && !el.textContent?.trim()) {
      el.setAttribute('aria-label', text);
    }

    const cut = text.indexOf(SPLIT);
    el.dataset.tip = cut > 0 ? text.slice(0, cut) : text;
    if (cut > 0) el.dataset.tipNote = text.slice(cut + SPLIT.length);
    else delete el.dataset.tipNote;
  }

  show() {
    const el = this.target;
    if (!el || !el.isConnected) return this.hide();
    this.harvest(el);
    this.ensure();

    this.el.querySelector('.ttl').textContent = el.dataset.tip ?? '';

    const key = el.dataset.tipKey ?? '';
    const keyEl = this.el.querySelector('.key');
    keyEl.textContent = key;
    keyEl.hidden = !key;

    const note = el.dataset.tipNote ?? '';
    const noteEl = this.el.querySelector('.note');
    noteEl.textContent = note;
    noteEl.hidden = !note;
    // `dataset.tone = ''` still writes the attribute, and an empty tone would
    // match no rule but would keep the element looking like it had one to a
    // reader. Removing it is what makes "no tone" the absence of a tone.
    if (el.dataset.tipTone) noteEl.dataset.tone = el.dataset.tipTone;
    else delete noteEl.dataset.tone;

    this.place();
    // Two frames, not one. The box has to be laid out at its new size before
    // the class goes on, or the transition runs from wherever it was last time
    // and the tip visibly slides in from the previous button.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (this.target === el) this.el?.classList.add('show');
    }));
  }

  /**
   * Above the thing, centred on it, and inside the screen — in that order of
   * priority, because the last one can only be honoured by breaking the second.
   *
   * So when the box is pushed off the button by the edge of the screen, the
   * CARET stays over the button and the box slides out from under it. A tip
   * that centres itself perfectly and points at nothing is worse than one that
   * is off to one side, especially on the rail, where the neighbours are eight
   * more of the same shape.
   *
   * Anchored by `bottom` against the top of the button rather than by `top`,
   * so a tip that grows a second line grows UPWARD and its caret stays glued
   * where it was. Anchored by `top` it would push itself off the button every
   * time the note got longer.
   *
   * ...and it flips below when there is no room above, which is not an edge
   * case: the rail is at the bottom of the screen and the meters are at the
   * top, so the two halves of the HUD want opposite answers. A tip clamped
   * against the top of the screen instead would cover the very readout it was
   * sent to explain.
   */
  place() {
    const r = this.target.getBoundingClientRect();
    const mid = r.left + r.width / 2;

    // Measured from a clean slate: the box is still sized to the LAST thing it
    // described until it is laid out again, and clamping against that width
    // puts this one in the wrong place whenever the two differ.
    this.el.style.left = '0px';
    this.el.style.top = '0px';
    this.el.style.bottom = 'auto';
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;

    // Above unless it does not fit AND there is more room the other way, so a
    // tip on something in a cramped middle of the screen still goes up — which
    // is where a tooltip belongs when it is a free choice.
    const down = r.top - GAP - h < MARGIN && window.innerHeight - r.bottom > r.top;
    this.el.classList.toggle('down', down);
    if (down) {
      this.el.style.top = `${r.bottom + GAP}px`;
    } else {
      this.el.style.top = 'auto';
      this.el.style.bottom = `${window.innerHeight - r.top + GAP}px`;
    }

    const left = Math.max(MARGIN, Math.min(mid - w / 2, window.innerWidth - MARGIN - w));
    this.el.style.left = `${left}px`;

    // The caret, kept over the button, and pulled in from the box's own corners
    // so it can never hang off a rounded edge.
    const caret = Math.max(12, Math.min(mid - left, w - 12));
    this.el.querySelector('.arrow').style.left = `${caret}px`;
    // …and the tip grows out of the caret rather than out of its own middle,
    // which is what makes a clamped one still read as belonging to the button.
    this.el.style.transformOrigin = `${caret}px ${down ? '0' : '100%'}`;
  }

  /**
   * Repaint a tip that is already up, because what it says has changed.
   *
   * The rail rewrites its delivery line as the van gets closer. Without this a
   * tip opened at the start of that sentence sits there stating a number of
   * crates that stopped being true while you were reading it — and the one
   * moment it matters is the one where you are hovering to find out.
   */
  refresh(el) {
    if (this.target !== el || !this.el) return;
    this.show();
  }

  hide() {
    clearTimeout(this.timer);
    this.timer = 0;
    this.target = null;
    this.el?.classList.remove('show');
  }
}

export const tip = new Tip();
