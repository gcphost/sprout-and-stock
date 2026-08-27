/**
 * TWO PEOPLE, ONE SHOP — the front of step 6 in docs/browser.md.
 *
 * A self-contained overlay rather than a HUD panel, and the same argument
 * `client/menu.js` makes about itself applies: the panel system draws over a
 * running game and reads from a snapshot, and half of what happens here happens
 * when there is no game and no connection at all. It owns its own element and
 * removes it.
 *
 * THE CODE IS THE WHOLE INTERFACE, and the shape of it is forced by owning no
 * servers. Two browsers cannot find each other unaided, so somebody carries one
 * offer and one answer between them, and that somebody is the player with a
 * chat window open. Hence a flow that is genuinely two paste operations and
 * cannot honestly be fewer: Host gives a code, Join turns it into a second code,
 * Host takes that back. A broker collapses it to one click and is step 7 —
 * additive, and nothing here changes when it lands.
 *
 * WHAT IT MUST NOT DO IS SPIN FOREVER. Roughly a low-teens percentage of network
 * pairs cannot reach each other directly, there is no TURN relay in this design,
 * and neither player did anything wrong. So every wait here has a deadline and
 * an explanation in words — see `client/peer.js`, which owns the message. A
 * spinner is the one failure nobody can act on and nobody can report.
 */

const css = `
.coop-veil{position:fixed;inset:0;background:rgba(58,49,40,.34);backdrop-filter:blur(3px);
  display:grid;place-items:center;z-index:9000;padding:20px;
  font:14px/1.5 ui-rounded,system-ui,sans-serif;color:var(--ink,#3a3128)}
.coop{background:var(--panel-solid,#fffcf5);border-radius: var(--r, 2px);padding:20px 22px 18px;
  width:min(460px,94vw);max-height:88vh;overflow:auto;
  box-shadow:0 18px 50px rgba(58,49,40,.28)}
.coop h2{margin:0 0 3px;font-size:16px;font-weight:800}
.coop p{margin:0 0 12px;font-size:12.5px;opacity:.62;line-height:1.45}
.coop-step{font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  opacity:.42;margin-bottom:5px}
.coop hr{border:0;border-top:1px solid var(--line,rgba(58,49,40,.14));margin:18px 0 16px}

/* The code itself. Monospace and SMALL on purpose: it is not for reading, it is
   for copying, and a field sized to be legible would be four times the height of
   the dialogue. Two colours, because the two do opposite jobs — the one you send
   is output and sits flat, the one you paste is a field and looks like one. */
.coop-code{width:100%;height:62px;resize:none;box-sizing:border-box;
  font:10.5px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;
  border:0;border-radius: var(--r, 2px);padding:9px 11px;color:var(--ink,#3a3128);outline:0}
.coop-code.out{background:rgba(58,49,40,.06);opacity:.75}
.coop-code.in{background:var(--panel,rgba(255,252,245,.94));
  box-shadow:inset 0 0 0 2px rgba(58,49,40,.14)}
.coop-code.in:focus{box-shadow:inset 0 0 0 2px var(--good,#5aa356)}

.coop-row{display:flex;gap:8px;margin-top:11px;align-items:center}
.coop button{font:inherit;font-size:13px;font-weight:800;padding:9px 15px;border:0;
  border-radius: var(--r, 2px);cursor:pointer;color:var(--ink,#3a3128);
  background:rgba(58,49,40,.08);box-shadow:0 3px 0 rgba(58,49,40,.14);
  transition:filter .12s ease}
.coop button:hover{filter:brightness(1.04)}
.coop button:active{transform:translateY(3px);box-shadow:none}
.coop button.go{background:var(--good,#5aa356);color:#fff;box-shadow:0 3px 0 #43793f;flex:1}
.coop button:disabled{opacity:.45;cursor:default;filter:none}

.coop-note{margin-top:11px;font-size:12px;opacity:.62;min-height:1.3em}
.coop-note.bad{background:#ffd66b;opacity:1;border-radius: var(--r, 2px);padding:8px 11px;
  font-weight:600;line-height:1.4}

/* The room code.
   Tiles rather than a string, because this is the one thing on screen somebody
   reads out loud over a call — a character with its own edges is one you do not
   lose your place in. It is the hero of this dialogue and sits on the panel
   itself rather than in a box: two stacked grey boxes of near-equal weight was
   the first draft, and what it read as was a form. */
.coop-codebox{display:block;width:100%;padding:4px 0 0;border:0;cursor:pointer;
  background:none;box-shadow:none}
.coop-codebox:active{transform:none;box-shadow:none}
.coop-tiles{display:flex;gap:7px;justify-content:center}
.coop-tile{font:800 30px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--ink,#3a3128);background:var(--panel,rgba(255,252,245,.94));
  border-radius: var(--r, 2px);padding:13px 4px;min-width:38px;text-align:center;
  box-shadow:inset 0 0 0 2px rgba(58,49,40,.12),0 3px 0 rgba(58,49,40,.13);
  transition:transform .12s ease}
.coop-codebox:hover .coop-tile{transform:translateY(-2px)}
.coop-copyhint{margin-top:9px;font-size:11px;font-weight:800;letter-spacing:.05em;
  text-transform:uppercase;opacity:.35;text-align:center}
.coop-codebox.done .coop-copyhint,.coop-link.done .coop-copyhint{opacity:1;color:var(--good,#5aa356)}

/* The link is not for reading — it is for sending — so it gets one line, an
   ellipsis and a button, rather than three centred lines of wrapped monospace
   broken mid-word. */
.coop-link{display:flex;align-items:center;gap:8px;width:100%;margin-top:16px;
  padding:8px 8px 8px 13px;border:0;cursor:pointer;text-align:left;
  background:rgba(58,49,40,.06);border-radius: var(--r, 2px);box-shadow:none;
  transition:background .12s ease}
.coop-link:hover{background:rgba(58,49,40,.1)}
.coop-link:active{transform:none;box-shadow:none}
.coop-linktext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font:700 12.5px/1.6 ui-monospace,Menlo,monospace;opacity:.7}
.coop-link .coop-copyhint{margin:0;flex:0 0 auto;padding:6px 11px;border-radius: var(--r, 2px);
  background:var(--panel-solid,#fffcf5);box-shadow:0 2px 0 rgba(58,49,40,.14);
  opacity:.75;font-size:10.5px}
.coop-sub{text-align:center;font-size:12px;opacity:.55;margin-top:16px}
.coop-row{display:flex;gap:8px;margin-top:11px;align-items:center}
.coop button{font:inherit;font-size:13px;font-weight:800;padding:9px 15px;border:0;
  border-radius: var(--r, 2px);cursor:pointer;color:var(--ink,#3a3128);
  background:rgba(58,49,40,.08);box-shadow:0 3px 0 rgba(58,49,40,.14);
  transition:filter .12s ease}
.coop button:hover{filter:brightness(1.04)}
.coop button:active{transform:translateY(3px);box-shadow:none}
.coop button.go{background:var(--good,#5aa356);color:#fff;box-shadow:0 3px 0 #43793f;flex:1}
.coop button:disabled{opacity:.45;cursor:default;filter:none}

.coop-note{margin-top:11px;font-size:12px;opacity:.62;min-height:1.3em}
.coop-note.bad{background:#ffd66b;opacity:1;border-radius: var(--r, 2px);padding:8px 11px;
  font-weight:600;line-height:1.4}

/* The room code, when there is a broker.
   A row of tiles rather than a string, because this is the one thing on screen
   somebody reads out loud over a call — a character with its own edges is one
   you do not lose your place in. The whole row is a button: the only thing
   anybody wants to do with it is copy it, so there is no reason to make them
   select it first. */
.coop-codebox{display:block;width:100%;padding:14px 8px 12px;border:0;cursor:pointer;
  background:rgba(58,49,40,.05);border-radius: var(--r, 2px);box-shadow:none;
  transition:background .12s ease}
.coop-codebox:hover{background:rgba(58,49,40,.09)}
.coop-codebox:active{transform:none;box-shadow:none}
.coop-tiles{display:flex;gap:6px;justify-content:center;flex-wrap:wrap}
.coop-tile{font:800 30px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--ink,#3a3128);background:var(--panel-solid,#fffcf5);
  border-radius: var(--r, 2px);padding:12px 4px;min-width:34px;text-align:center;
  box-shadow:0 3px 0 rgba(58,49,40,.16);transition:transform .12s ease}
.coop-codebox:hover .coop-tile{transform:translateY(-1px)}
.coop-copyhint{margin-top:10px;font-size:11px;font-weight:800;letter-spacing:.05em;
  text-transform:uppercase;opacity:.42;text-align:center}
.coop-codebox.done .coop-copyhint{opacity:1;color:var(--good,#5aa356)}
.coop-linktext{font:700 13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--ink,#3a3128);text-align:center;word-break:break-all;padding:0 6px}
.coop-sub{text-align:center;font-size:12px;opacity:.55;margin-top:12px}
.coop-sub.waiting::after{content:'';display:inline-block;width:6px;height:6px;
  margin-left:7px;border-radius: var(--r, 2px);background:var(--good,#5aa356);
  vertical-align:middle;animation:coop-pulse 1.3s ease-in-out infinite}
@keyframes coop-pulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}

/* The wait. Everything on this screen is happening on somebody else's machine,
   so there is nothing to report and nothing to press — which is exactly the
   screen that reads as broken if it is only words. Three dots that are visibly
   alive is the whole job. */
.coop-wait{display:flex;flex-direction:column;align-items:center;gap:14px;
  padding:6px 0 2px;text-align:center}
.coop-dots{display:flex;gap:9px}
.coop-dots i{width:11px;height:11px;border-radius: var(--r, 2px);background:var(--good,#5aa356);
  animation:coop-bounce 1.15s ease-in-out infinite}
.coop-dots i:nth-child(2){animation-delay:.16s}
.coop-dots i:nth-child(3){animation-delay:.32s}
@keyframes coop-bounce{0%,70%,100%{transform:translateY(0);opacity:.35}
  35%{transform:translateY(-7px);opacity:1}}
.coop-wait h2{margin:0}
.coop-wait p{margin:0}
.coop-alt{margin-top:14px;font-size:11.5px;opacity:.5;text-align:center}
.coop-alt button{font-size:11.5px;padding:0;background:none;box-shadow:none;
  text-decoration:underline;opacity:.85}
.coop-alt button:active{transform:none}

`;


/**
 * The stylesheet, injected once.
 *
 * Its own function because TWO things need it and only one of them is the
 * dialogue: the invite pill is mounted the moment a shop opens, long before
 * anybody presses anything. It used to be injected by `mount()` alone, so the
 * button appeared with no styles at all — which does not look like a styling
 * bug, it looks like a missing feature, because an unstyled `position: static`
 * button lands at the end of the document under the canvas and is simply not
 * on screen.
 */
function styles() {
  if (document.getElementById('coop-css')) return;
  const style = document.createElement('style');
  style.id = 'coop-css';
  style.textContent = css;
  document.head.appendChild(style);
}

function mount() {
  styles();
  const veil = document.createElement('div');
  veil.className = 'coop-veil';
  veil.innerHTML = '<div class="coop"></div>';
  document.body.appendChild(veil);
  return { veil, box: veil.firstChild, close: () => veil.remove() };
}

/** Select-and-copy, with the fallback that matters on http:// and old Safari. */
async function copy(el, button) {
  try {
    await navigator.clipboard.writeText(el.value);
  } catch {
    el.select();
    document.execCommand?.('copy');
  }
  const had = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = had; }, 1400);
}

/**
 * HOST: hand somebody a code, take theirs back, and they are in your shop.
 *
 * `net` is the `LocalNet` already running the shop — the guest becomes an
 * ordinary client of the room it is already hosting, so nothing about the game
 * changes and the second person simply exists.
 */
export async function showHost(net, { onJoined } = {}) {
  const { box, close } = mount();
  box.innerHTML = `
    <div class="coop-step">Step 1 of 2</div>
    <h2>Invite a friend</h2>
    <p>Building an invite code…</p>
    <div class="coop-note">Finding a way through your network — a few seconds.</div>`;

  let session = null;
  try {
    session = await net.host({
      onProgress: (n) => {
        const note = box.querySelector('.coop-note');
        if (note) note.textContent = `Finding a way through your network — ${n} route${n === 1 ? '' : 's'} so far.`;
      },
    });
  } catch (err) {
    box.innerHTML = `<h2>Could not start</h2><div class="coop-note bad">${err.message}</div>`;
    box.append(Object.assign(document.createElement('button'), { textContent: 'Close', onclick: close }));
    return;
  }

  const { haveBroker } = await import('./broker.js');
  if (haveBroker()) {
    // The short-code path. Everything about the connection is identical — the
    // same offer, the same answer, the same data channel — and the only
    // difference is who carries the two blobs between the browsers.
    try {
      return await hostWithCode(box, close, session, onJoined);
    } catch (err) {
      // Falling THROUGH rather than failing: a broker that is down, blocked or
      // rate-limited is a longer code, not a broken feature. This is the whole
      // reason the paste flow was built first and stays.
      console.warn('[coop] broker unavailable, falling back to codes:', err.message);
    }
  }

  box.innerHTML = `
    <div class="coop-step">Step 1 of 2</div>
    <h2>Send them this code</h2>
    <p>Paste it into a chat. They press <b>Join a friend</b> and paste it in.</p>
    <textarea readonly class="coop-code out" id="coop-out"></textarea>
    <div class="coop-row"><button id="coop-copy">Copy code</button></div>
    <hr><div class="coop-step">Step 2 of 2</div>
    <h2>Paste their reply</h2>
    <p>They will get a code back. Paste it here and they are in.</p>
    <textarea class="coop-code in" id="coop-in" placeholder="Paste their reply code here"></textarea>
    <div class="coop-row">
      <button class="go" id="coop-go">Let them in</button>
      <button id="coop-cancel">Cancel</button>
    </div>
    <div class="coop-note"></div>`;

  const out = box.querySelector('#coop-out');
  out.value = session.code;
  const note = box.querySelector('.coop-note');
  box.querySelector('#coop-copy').onclick = (e) => copy(out, e.target);
  box.querySelector('#coop-cancel').onclick = () => { session.cancel(); close(); };

  const go = box.querySelector('#coop-go');
  go.onclick = async () => {
    const code = box.querySelector('#coop-in').value.trim();
    if (!code) return;
    go.disabled = true;
    note.className = 'coop-note';
    note.textContent = 'Connecting…';
    try {
      await session.accept(code);
      note.textContent = 'They are in the shop.';
      onJoined?.();
      setTimeout(close, 900);
    } catch (err) {
      go.disabled = false;
      note.className = 'coop-note bad';
      note.textContent = err.message;
    }
  };
}


/**
 * HOST, with a broker: one code, said out loud, and no pasting at all.
 *
 * Throws if the broker cannot be reached, which is `showHost`'s cue to fall
 * back to the two-paste flow — so every failure in here has to happen *before*
 * anything irreversible. It does: the offer already exists either way, and
 * publishing it is the first and only network call.
 */
async function hostWithCode(box, close, session, onJoined) {
  const { publish, awaitAnswer } = await import('./broker.js');
  const code = await publish(session.code);

  // The link is the code with a page around it. `?join=` is read by `main.js`
  // before the menu is ever drawn, so the person you send it to lands in your
  // shop rather than at a form with an empty box — which is the difference
  // between "here, play" and "here, follow these instructions".
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('join', code);
  const link = url.toString();

  const stop = new AbortController();

  const render = (into, dismiss) => {
    into.innerHTML = `
      <h2>Invite a friend</h2>
      <p>Read them the code, or send the link.</p>
      <button class="coop-codebox" id="coop-codebox" title="Copy the code">
        <div class="coop-tiles">${[...code].map((c) => `<span class="coop-tile">${c}</span>`).join('')}</div>
        <div class="coop-copyhint">Click to copy</div>
      </button>
      <button class="coop-link" id="coop-link" title="Copy the link">
        <span class="coop-linktext">${link.replace(/^https?:\/\//, '')}</span>
        <span class="coop-copyhint">Copy link</span>
      </button>
      <div class="coop-sub waiting" id="coop-sub">Waiting for them to join · works for five minutes</div>
      <div class="coop-row">
        <button class="go" id="coop-hide">Back to the shop</button>
        <button id="coop-cancel">Cancel invite</button>
      </div>
      <div class="coop-note"></div>`;

    // Closing this is NOT cancelling it. What is being waited on is somebody
    // opening a link, which can take a minute — and a dialogue that has to stay
    // open to work means the host stands still in their own shop while it
    // happens. The wait outlives the box; the pill in the corner is where it
    // lives, and pressing that brings this back.
    into.querySelector('#coop-hide').onclick = dismiss;
    into.querySelector('#coop-cancel').onclick = () => {
      stop.abort(); session.cancel(); live = null; dismiss();
    };

    copyOnClick(into.querySelector('#coop-link'), link, 'Link copied');
    copyOnClick(into.querySelector('#coop-codebox'), code, 'Copied');
  };

  live = { code, render, stop };
  render(box, close);

  // Deliberately not awaited by the caller: `showHost` is finished the moment
  // there is something on screen to send, and everything after this happens
  // whether or not anybody is looking at it.
  (async () => {
    try {
      const answer = await awaitAnswer(code, { signal: stop.signal });
      await session.accept(answer);
      live = null;
      onJoined?.();
      const sub = document.querySelector('#coop-sub');
      if (sub) { sub.className = 'coop-sub'; sub.textContent = 'They are in the shop 🎉'; }
      setTimeout(() => document.querySelector('.coop-veil')?.remove(), 1200);
    } catch (err) {
      if (stop.signal.aborted) return;
      live = null;
      const note = document.querySelector('.coop-note');
      if (note) { note.className = 'coop-note bad'; note.textContent = err.message; }
    }
  })();
}

/** Copy on press, with the selection fallback that matters on plain http. */
function copyOnClick(button, text, said) {
  if (!button) return;
  const hint = button.querySelector('.coop-copyhint');
  const idle = hint.textContent;
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(button.firstElementChild);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
    button.classList.add('done');
    hint.textContent = said;
    setTimeout(() => { button.classList.remove('done'); hint.textContent = idle; }, 1600);
  };
}

/**
 * The invite that is out, if there is one.
 *
 * Module-level because it outlives the dialogue that started it — see the note
 * in `render` about why closing the box must not cancel the invite.
 */
let live = null;
/** How many people are in the shop who are not you. Kept by the transport. */
let friends = 0;

/**
 * What the Menu's row is currently saying, as a string to diff on.
 *
 * The panel repaints when its `live()` signature moves, and both halves of this
 * change behind the menu's back: a code is minted or spent by a promise nobody
 * awaits, and the peer count arrives on a wire. `friends` is a count the
 * transport reports rather than a flag set once when somebody joins, and that
 * distinction is load-bearing — the old pill wrote "⇄ Friend connected" at the
 * moment of joining and never unwrote it, so a guest who closed their tab left
 * the host looking at a button claiming they were still there, which is the
 * same lie the shop itself was telling one layer up.
 */
export const coopSignature = () => `${live?.code ?? '-'}:${friends}`;

/**
 * GUEST: the shop has gone.
 *
 * A veil rather than a toast, and it is the one screen in here that offers
 * nothing to try again with — because there is nothing. The shop was on
 * somebody else's machine, and this browser holds no copy of it, no save and no
 * way back in without a fresh invite. That is the downgrade this build accepts
 * in exchange for owning no servers, and the whole of the answer is to say it
 * plainly at the moment it happens rather than let somebody work it out from a
 * shop that stopped moving.
 */
export function showHostGone() {
  if (document.querySelector('.coop-veil')) return;
  const { box } = mount();
  box.innerHTML = `
    <h2>The shop has closed</h2>
    <p>Whoever was hosting has closed their tab or lost their connection. Their
       shop runs on their machine, so it goes when they do — ask them for a new
       invite when they are back.</p>
    <div class="coop-row"><button class="go" id="coop-home">Back to my own shops</button></div>`;
  box.querySelector('#coop-home').onclick = () => {
    // A reload rather than a route: a guest has no world open, and everything
    // this page is holding is a picture of a shop that is not there any more.
    const url = new URL(location.href);
    url.search = '';
    location.href = url.toString();
  };
}

/**
 * GUEST: turn what they sent you into a seat in their shop.
 *
 * Two shapes of code, and the box starts on whichever this build can do. A
 * broker build asks for six characters and can be talked down to the long one,
 * because the person inviting you may be on a build or a network where the
 * broker did not work — and from this side those two are indistinguishable
 * until you look at what they actually sent.
 *
 * Resolves with an open channel, or `null` if they backed out — which is the
 * front door's cue to go back to the shop list.
 */
export async function showJoin({ name, code } = {}) {
  const { box, close } = mount();
  const { acceptOffer } = await import('./peer.js');
  const { haveBroker, fetchOffer, sendAnswer } = await import('./broker.js');
  // Straight from the transport rather than passed in by every caller: `who` is
  // one fact about this browser and there is one place it is minted. It travels
  // in the answer because the host needs it at `room.join` — a tick later is
  // already a stranger who has been spawned.
  const { whoAmI } = await import('./localnet.js');
  let short = haveBroker();

  return new Promise((resolve) => {
    const bail = () => { close(); resolve(null); };

    const shortForm = () => `
      <h2>Join a friend's shop</h2>
      <p>Type the code they gave you.</p>
      <input class="coop-code in" id="coop-in" placeholder="CODE" maxlength="8"
        autocapitalize="characters" spellcheck="false"
        style="height:auto;font:800 26px/1 ui-monospace,Menlo,monospace;
               letter-spacing:.14em;text-align:center;padding:14px 10px">
      <div class="coop-row">
        <button class="go" id="coop-go">Join</button>
        <button id="coop-back">Back</button>
      </div>
      <div class="coop-note"></div>
      <div class="coop-alt">Sent you a long code instead?
        <button id="coop-swap">Paste it here</button></div>`;

    const longForm = () => `
      <div class="coop-step">Step 1 of 2</div>
      <h2>Join a friend's shop</h2>
      <p>Paste the invite code they sent you.</p>
      <textarea class="coop-code in" id="coop-in" placeholder="Paste their invite code here"></textarea>
      <div class="coop-row">
        <button class="go" id="coop-go">Continue</button>
        <button id="coop-back">Back</button>
      </div>
      <div class="coop-note"></div>`;

    function ask() {
      box.innerHTML = short ? shortForm() : longForm();
      box.querySelector('#coop-back').onclick = bail;
      box.querySelector('#coop-swap')?.addEventListener('click', () => { short = false; ask(); });
      box.querySelector('#coop-go').onclick = go;
      box.querySelector('#coop-in').focus();
    }

    async function go() {
      const typed = box.querySelector('#coop-in').value.trim();
      if (!typed) return;
      const note = box.querySelector('.coop-note');
      note.className = 'coop-note';
      note.textContent = short ? 'Looking up that code…' : 'Working out how to reach them…';

      try {
        // With a broker the typed thing is a *ticket*; the invite is what it
        // fetches. Without one it is the invite itself.
        const invite = short ? await fetchOffer(typed) : typed;
        side = await acceptOffer(invite, { who: whoAmI(), name });

        if (short) {
          // Hand the answer straight back and there is no second step at all —
          // which is the entire feature.
          await sendAnswer(typed, side.code);
          waiting('Joining their shop', 'Hooking the two browsers up — this takes a few seconds.');
        } else {
          swapBack(side.code);
        }

        const channel = await side.ready();
        close();
        resolve(channel);
      } catch (err) {
        const n = box.querySelector('.coop-note');
        if (!n) return;
        n.className = 'coop-note bad';
        n.textContent = err.message;
      }
    }

    /** The broker path's only screen after the code: a wait with a deadline. */
    function waiting(title, sub) {
      box.innerHTML = `
        <div class="coop-wait">
          <div class="coop-dots"><i></i><i></i><i></i></div>
          <h2>${title}</h2>
          <p>${sub}</p>
        </div>
        <div class="coop-row" style="justify-content:center">
          <button id="coop-back" style="flex:0">Cancel</button>
        </div>
        <div class="coop-note"></div>`;
      box.querySelector('#coop-back').onclick = () => { side?.close(); bail(); };
    }

    /** The paste path's second step: your reply, for them to drop in. */
    function swapBack(reply) {
      box.innerHTML = `
        <div class="coop-step">Step 2 of 2</div>
        <h2>Send them this back</h2>
        <p>Paste it into the same chat. They drop it into their box and you are in.</p>
        <textarea readonly class="coop-code out" id="coop-out"></textarea>
        <div class="coop-row">
          <button id="coop-copy">Copy code</button>
          <button id="coop-back">Back</button>
        </div>
        <div class="coop-note">Waiting for them…</div>`;
      const out = box.querySelector('#coop-out');
      out.value = reply;
      box.querySelector('#coop-copy').onclick = (e) => copy(out, e.target);
      box.querySelector('#coop-back').onclick = () => { side?.close(); bail(); };
    }

    let side = null;
    ask();
    // Arrived on a link. The code is already in hand, so the form is a step
    // nobody chose to take — fill it in and go, and the box is still there
    // underneath if it fails.
    if (code && short) {
      box.querySelector('#coop-in').value = String(code).toUpperCase();
      go();
    }
  });
}

/**
 * Watch who is in the shop, so the Menu row can say.
 *
 * THIS USED TO BE A FLOATING PILL, bottom left, and its own note said the
 * placement was one to revisit: docs/ui-shell.md is clear that anything
 * offering an action belongs in `#panel`, and a pill on the glass does not.
 * What settled it is a phone — `left: 12px; bottom: 12px` is the corner the
 * nav wraps into, so the one control in the game that says "somebody else can
 * play this" sat under the row of buttons you press to do anything. A fixed
 * corner is a promise about a screen size, and there is no corner left on a
 * phone that nothing else has claimed.
 *
 * So the button is a row in the Menu (the Game tab in client/sections.js) and
 * this keeps only the half that cannot live there: the peer count, which the
 * transport reports and nothing else hears. Counting joins where the button is
 * drawn is how the old pill came to claim a friend was connected for the rest
 * of the session — a menu that is redrawn on a snapshot would have the same
 * bug, so the count still lives here and the row asks for it.
 *
 * Only wired when the transport can host: the server build has nothing to
 * offer, because both people open the same URL.
 */
export function watchCoop(net) {
  if (!net?.host) return;
  net.on?.('peers', (e) => { friends = e?.count ?? 0; });
}

/**
 * What the Menu's row should say, and whether there is one at all.
 *
 * The same three states the pill wore, in the same order and for the same
 * reason: an invite that is OUT outranks a friend already in, because it is the
 * one with something still to happen — somebody is being read a code and this
 * is where it is written down. Inviting a second person while a first is in the
 * shop is an ordinary thing to do.
 */
export function coopStatus(net) {
  if (!net?.host) return null;
  return {
    live: !!live,
    friends,
    on: !!live || friends > 0,
    code: live?.code ?? null,
    name: live ? `Waiting · ${live.code}`
      : friends > 0 ? `${friends} friend${friends === 1 ? '' : 's'} in`
        : 'Invite a friend',
    sub: live ? 'the code is out — press to show it again'
      : friends > 0 ? 'somebody else is playing this shop'
        : 'let somebody else into this shop',
  };
}

/** Open the dialogue, or re-show the invite that is already out. */
export function openCoop(net) {
  // An invite already out is *reopened* rather than replaced. Minting a second
  // code would quietly retire the one they are already typing in.
  if (live) {
    const { box, close } = mount();
    live.render(box, close);
    return;
  }
  showHost(net);
}
