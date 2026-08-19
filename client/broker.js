/**
 * ASKING THE BROKER TO INTRODUCE US.
 *
 * The client half of step 7 in docs/browser.md. It turns two kilobytes of
 * base64 that somebody has to paste into a six-character word they can say out
 * loud, and it changes nothing else: the offer and the answer are the same
 * blobs, the data channel is the same channel, and the game traffic never goes
 * near a server.
 *
 * IT IS OPTIONAL, and that is deliberate rather than defensive. `VITE_SNS_BROKER`
 * unset means the paste flow from step 6, which is the one that owns no
 * infrastructure at all — so a fork of this game, or a build served off a USB
 * stick, still has working co-op. Every failure in here falls back to it too:
 * a broker that is down, rate-limited or blocked by a network is a longer code,
 * not a broken feature.
 */

/**
 * The project's own broker. See broker/wrangler.toml.
 *
 * A literal with an env override rather than an env var with no default,
 * because `.env` is gitignored here — so a fresh checkout would build a game
 * whose co-op silently fell back to pasting 2KB codes by hand, which is a
 * working game with a worse feature and nothing anywhere to say why. A URL is
 * not a secret; it holds two connection blobs for five minutes.
 *
 * `VITE_SNS_BROKER=''` in the environment turns it off deliberately, which is
 * the supported configuration for a fork that does not want ours.
 */
const DEFAULT_BROKER = 'https://sprocket-broker.gcphost-account.workers.dev';

export const BROKER = import.meta.env.VITE_SNS_BROKER ?? DEFAULT_BROKER;

export const haveBroker = () => !!BROKER;

/** How long the host waits for somebody to use the code. */
const WAIT_MS = 5 * 60 * 1000;
/**
 * How often the host asks whether they have joined.
 *
 * Two seconds rather than something eager: the thing being waited on is a human
 * reading a code off one screen and typing it into another, so a faster poll is
 * a hundred more requests for the same answer.
 */
const POLL_MS = 2000;

async function ask(path, body) {
  const res = await fetch(`${BROKER}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: `${res.status}` }));
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `broker said ${res.status}`);
  return json;
}

/** HOST: publish the offer, get a short code back. */
export async function publish(offer) {
  const { code } = await ask('/new', { offer });
  return code;
}

/**
 * HOST: wait for the guest's answer to turn up.
 *
 * Resolves with the answer blob, or rejects when the code has been sitting
 * unused long enough that whoever was going to use it is not going to. The
 * message matters more than the timeout: a code that has quietly expired and a
 * friend who has not looked at their phone are the same blank screen.
 */
export async function awaitAnswer(code, { signal } = {}) {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    if (signal?.aborted) throw new Error('cancelled');
    const { answer } = await ask(`/room/${encodeURIComponent(code)}/answer`);
    if (answer) return answer;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error('Nobody used that code. It has expired — make a new one when they are ready.');
}

/** GUEST: swap the code for the host's offer. */
export async function fetchOffer(code) {
  const { offer } = await ask(`/room/${encodeURIComponent(String(code).trim().toUpperCase())}`);
  return offer;
}

/** GUEST: hand the answer back for the host to pick up. */
export async function sendAnswer(code, answer) {
  await ask(`/room/${encodeURIComponent(String(code).trim().toUpperCase())}/answer`, { answer });
}
