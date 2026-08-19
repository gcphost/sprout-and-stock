/**
 * THE WIRE BETWEEN TWO BROWSERS.
 *
 * Step 6 of docs/browser.md. A `RTCDataChannel` carrying the same frames the
 * Worker carries — `[type, payload]`, the shape `ShopRoom` has always been
 * handed — so neither the room nor the client learns that the other end is a
 * different machine.
 *
 * WHY THERE IS NO SERVER IN HERE, and why that is not quite the whole truth.
 * Game traffic is genuinely peer to peer: nothing of ours is in the path, and
 * a shop two people are playing costs us nothing to run. But two browsers
 * cannot *find* each other unaided — somebody has to carry one offer and one
 * answer between them, and here that somebody is the player, pasting a code
 * into a chat. That is the entire reason this design owns no infrastructure,
 * and it is one paste more than a link would be. A broker would make it one
 * click and is a later, additive step (docs/browser.md step 7).
 *
 * VANILLA ICE, deliberately. The usual WebRTC flow trickles candidates as they
 * are discovered, which needs a live channel between the peers — exactly the
 * thing that does not exist yet. So both sides wait for gathering to *finish*
 * and put everything in one blob. It costs a few seconds before the code
 * appears, which is why `createOffer` reports progress rather than simply
 * hanging: a button that does nothing for four seconds is a button somebody
 * presses twice.
 *
 * AND IT CAN FAIL, for a reason neither player did anything about. STUN gets
 * most pairs connected; two symmetric NATs need a relay (TURN), which is a
 * server somebody pays for and this design has none. That is a low-teens
 * percentage of pairs, and the whole of the answer is to say so in words —
 * see `waitOpen`. A spinner that never resolves is the failure we cannot
 * action.
 */

/**
 * Public STUN only. No TURN, so a pair that cannot reach each other directly
 * cannot play — see the note above, and be honest in the UI rather than
 * hopeful.
 */
const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** How long to wait for ICE before sending what we have. */
const GATHER_MS = 5000;
/** How long to wait for the channel to actually open once codes are swapped. */
const OPEN_MS = 20000;

// ---------------------------------------------------------------------------
// The code somebody pastes
// ---------------------------------------------------------------------------

const B64 = {
  to: (bytes) => btoa(String.fromCharCode(...bytes)),
  from: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

/**
 * Squeeze the blob, because an SDP is about 3KB of repetitive text and a code
 * somebody has to paste into a chat window should not be a wall.
 *
 * gzip takes it to roughly a fifth. `CompressionStream` is in every browser
 * that has `RTCPeerConnection` worth supporting, but the fallback is plain
 * base64 rather than a failure: a long code still works, and a build that
 * refuses to host because it cannot compress would be choosing tidiness over
 * playing.
 */
async function pack(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream !== 'function') return `0${B64.to(raw)}`;
  const gz = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
  return `1${B64.to(new Uint8Array(await new Response(gz).arrayBuffer()))}`;
}

async function unpack(code) {
  const body = B64.from(String(code).trim().slice(1));
  if (String(code).trim()[0] === '0') return JSON.parse(new TextDecoder().decode(body));
  const un = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(un).text());
}

// ---------------------------------------------------------------------------

/**
 * The biggest thing a single data-channel message may be.
 *
 * SCTP caps a message, and where the cap is depends on the browser — Chrome
 * will take 256KB and others less. Over it, `send()` does not throw anything
 * useful: the message is simply dropped, or the channel closes.
 *
 * WHICH IS EXACTLY WHAT HAPPENED. The `catalog` frame carries every fixture in
 * the game and `fixtures.json` alone is 454KB, so a guest joined a shop, got
 * the layout, got the snapshot, and never got the models — and what that looks
 * like is a working game in which every shelf, till and freezer is an
 * untextured box. It reads as a rendering bug on a machine that has never
 * loaded the art, which is a long way from "one message was too big".
 *
 * 48KB leaves room under every browser's limit for the envelope.
 */
const CHUNK = 48 * 1024;

/** Marks a slice of a frame too big to send whole. Never a game message type. */
const PART = '@part';

/**
 * Wrap a `RTCDataChannel` as the channel `ChannelHost` and `LocalNet` speak.
 *
 * The identical three methods a Worker port gets, which is the whole reason
 * neither end of the game had to change: a channel is `{post, onFrame, close}`
 * and what is underneath it is nobody else's business — including, now, the
 * fact that a big frame crosses as nine.
 *
 * AND A FOURTH, WHICH ONLY THIS TRANSPORT NEEDS. A worker port never goes away
 * on its own: the thread dies with the page, and the page taking the shop with
 * it is a case the build already handles. A peer does go away on its own — a tab
 * closed, a laptop shut, a train tunnel — and the shape of a channel had no way
 * to say so, so both ends of a dropped connection carried on as though nothing
 * had happened. The host went on broadcasting at somebody who was not there,
 * with their avatar standing in the aisle holding stock nothing could ever get
 * back; the guest went on looking at a shop that had simply stopped, which is
 * the spinner this document keeps saying must not exist.
 *
 * TWO SIGNALS, because there are two ways to go. `close` is the polite one and
 * covers a closed tab, a pressed Leave, and the far end calling `close()`. The
 * connection reaching `failed` is the other, and it is the one that catches a
 * machine that went to sleep or a network that vanished — nothing is sent in
 * that case, so it is ICE giving up rather than anybody saying anything, and it
 * takes tens of seconds. `disconnected` is deliberately NOT one of them: it is
 * transient by definition and recovers on its own, and treating it as death
 * would throw people out of the shop over a lift.
 *
 * Fired at most once, and late subscribers are told immediately — the wire can
 * be dead before anybody gets round to asking about it.
 */
function wrap(dc, pc) {
  let onFrame = null;
  let onClose = null;
  let gone = false;
  const queued = [];
  /** Half-arrived frames, by id. */
  const building = new Map();
  let seq = 0;

  const went = () => {
    if (gone) return;
    gone = true;
    onClose?.();
  };
  dc.addEventListener('close', went);
  pc?.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') went();
  });

  const hand = (frame) => {
    if (onFrame) onFrame(frame);
    else queued.push(frame);
  };

  dc.onmessage = (e) => {
    let msg = null;
    // A frame that will not parse is dropped rather than thrown. The other end
    // is a *different build* of the game as far as this file knows, so garbage
    // on the wire is ordinary version skew and must not take the shop down.
    try { msg = JSON.parse(e.data); } catch { return; }

    if (Array.isArray(msg) && msg[0] === PART) {
      const [, id, index, total, slice] = msg;
      const parts = building.get(id) ?? { got: 0, slices: new Array(total) };
      if (parts.slices[index] === undefined) parts.got++;
      parts.slices[index] = slice;
      building.set(id, parts);
      if (parts.got < total) return;
      building.delete(id);
      // Reassembled, and parsed only now — a slice is a piece of text and not
      // a piece of JSON, so nothing between here and there could have looked
      // at it.
      try { hand(JSON.parse(parts.slices.join(''))); } catch { /* skewed */ }
      return;
    }
    hand(msg);
  };

  return {
    post: (frame) => {
      if (dc.readyState !== 'open') return;
      const text = JSON.stringify(frame);
      if (text.length <= CHUNK) { dc.send(text); return; }
      const id = `${++seq}`;
      const total = Math.ceil(text.length / CHUNK);
      for (let i = 0; i < total; i++) {
        dc.send(JSON.stringify([PART, id, i, total, text.slice(i * CHUNK, (i + 1) * CHUNK)]));
      }
    },
    onFrame: (fn) => {
      onFrame = fn;
      // Anything that arrived between the channel opening and somebody asking
      // for it. The host joins a peer to the room a tick after the channel
      // opens, and the guest's first message can be inside that tick.
      while (queued.length) fn(queued.shift());
    },
    /** Tell me when this wire is done for. See the note above. */
    onClose: (fn) => {
      onClose = fn;
      if (gone) fn();
    },
    // Closing the *peer connection* and not only the channel. A data channel
    // closed on its own leaves the connection up, which is a live ICE session
    // and a set of sockets held open for a shop nobody is in — and on the guest
    // side it is the last thing the page does before the shop is gone.
    close: () => { went(); dc.close(); pc?.close(); },
    get open() { return dc.readyState === 'open'; },
  };
}

function gathered(pc, onProgress) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, GATHER_MS);
    pc.onicecandidate = (e) => {
      onProgress?.(pc.localDescription?.sdp?.match(/^a=candidate/gm)?.length ?? 0);
      if (!e.candidate) done();
    };
  });
}

function waitOpen(dc) {
  return new Promise((resolve, reject) => {
    if (dc.readyState === 'open') return resolve();
    const timer = setTimeout(() => reject(new Error(
      'Could not connect. Your two networks will not talk to each other directly '
      + '— this happens with some home and mobile connections, and there is nothing '
      + 'either of you did wrong. Try again on a different network.',
    )), OPEN_MS);
    dc.onopen = () => { clearTimeout(timer); resolve(); };
    dc.onerror = () => { clearTimeout(timer); reject(new Error('The connection failed.')); };
  });
}

/**
 * HOST: make the invite.
 *
 * Resolves as soon as there is a code to paste. The channel is not open yet —
 * `accept` is the second half, and it is a separate call because a human has to
 * carry the code there and back in between.
 */
export async function createOffer({ onProgress } = {}) {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  // Created by the offerer, before the offer: a data channel added afterwards
  // needs a fresh round of negotiation, which is a second code to paste.
  const dc = pc.createDataChannel('shop', { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc, onProgress);

  return {
    code: await pack({ t: 'offer', sdp: pc.localDescription.sdp }),
    /** Feed in the guest's answer, then wait for the channel to come up. */
    accept: async (answerCode) => {
      const got = await unpack(answerCode);
      if (got?.t !== 'answer') throw new Error('That is not a join code — ask them to press Join and send you what it gives them.');
      await pc.setRemoteDescription({ type: 'answer', sdp: got.sdp });
      await waitOpen(dc);
      // The channel and who is on the other end of it. `who` is null from a
      // build older than this one, which `addPlayer` already has an answer for —
      // it is the same answer a browser with no local storage gets.
      return { channel: wrap(dc, pc), who: got.who ?? null, name: got.name ?? null };
    },
    close: () => pc.close(),
  };
}

/**
 * GUEST: take the invite, and hand back the code that finishes it.
 *
 * `ondatachannel` rather than creating one: the offerer made it, and both sides
 * making one is two channels of which one is silent.
 */
export async function acceptOffer(offerCode, { onProgress, who = null, name = null } = {}) {
  const got = await unpack(offerCode);
  if (got?.t !== 'offer') throw new Error('That is not an invite code — ask them to press Host and send you what it gives them.');

  const pc = new RTCPeerConnection({ iceServers: ICE });
  const arrived = new Promise((resolve) => { pc.ondatachannel = (e) => resolve(e.channel); });

  await pc.setRemoteDescription({ type: 'offer', sdp: got.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc, onProgress);

  return {
    /**
     * WHO IS ARRIVING RIDES IN THE ANSWER, and it has to — the host calls
     * `room.join` the moment this blob lands, and `addPlayer` wants `who` right
     * there: `Game.away` is keyed by it, so a guest who is nobody until their
     * first frame has already been spawned as a stranger by the time they say
     * so. It is two short strings on a blob that is already 3KB of SDP.
     */
    code: await pack({ t: 'answer', sdp: pc.localDescription.sdp, who, name }),
    /** Wait for the host to paste your code back in and the channel to open. */
    ready: async () => {
      const dc = await arrived;
      await waitOpen(dc);
      return wrap(dc, pc);
    },
    close: () => pc.close(),
  };
}

/** Whether this browser can do any of the above at all. */
export const canPeer = () => typeof RTCPeerConnection === 'function';
