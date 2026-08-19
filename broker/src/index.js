/**
 * THE BROKER — the only server this game has, and it does not know what a shop
 * is.
 *
 * Step 7 of docs/browser.md. Two browsers cannot find each other unaided: one
 * has to hand the other an offer and get an answer back. Step 6 made that a
 * person with a chat window, which works and asks somebody to paste two
 * kilobytes of base64. This holds those two blobs against a six-character code
 * for five minutes so that the paste becomes a word.
 *
 * WHAT IT IS NOT is the interesting part. No game traffic passes through it —
 * once the two peers have been introduced the data channel is direct, and this
 * could be switched off mid-session without either player noticing. It stores
 * no accounts, no saves, no shop, and nothing that outlives the five minutes. If
 * it is down, the game still works: `client/coop.js` falls back to the codes
 * being pasted by hand, which is why that path was built first and why it stays.
 *
 * A DURABLE OBJECT rather than KV, and the reason is a race rather than a
 * preference: KV is eventually consistent, so a guest reading a code the host
 * wrote a second ago can legitimately get nothing back, and what that looks like
 * is a room code that does not work until you try it twice. One room is one
 * object with one job and a lifetime in minutes, which is what these are for.
 */

/**
 * The alphabet a code is drawn from — 26 letters and digits with every
 * ambiguous pair removed: no O or 0, no I, L or 1, no S or 5, no B or 8.
 * Somebody is going to read this out loud over a voice call.
 */
const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY2346789';
const CODE_LEN = 6;

/** How long a room lives. Long enough to paste, short enough not to be storage. */
const TTL_MS = 5 * 60 * 1000;

function mintCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

const cors = (env) => ({
  'access-control-allow-origin': env.ALLOWED ?? '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
  // The answer is polled, and a cached 204 is a guest who joined and a host who
  // never finds out.
  'cache-control': 'no-store',
});

const json = (env, body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...cors(env) },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    // A host opening a room. The code is minted here rather than in the object,
    // because the object is *named* by it — you cannot ask a room for its own
    // name before you have one.
    if (url.pathname === '/new' && request.method === 'POST') {
      const { offer } = await request.json().catch(() => ({}));
      if (typeof offer !== 'string' || offer.length > 20000) {
        return json(env, { ok: false, error: 'no offer' }, 400);
      }
      const code = mintCode();
      const room = env.ROOMS.get(env.ROOMS.idFromName(code));
      await room.fetch('https://room/put', { method: 'POST', body: JSON.stringify({ offer }) });
      return json(env, { ok: true, code, expiresIn: TTL_MS / 1000 });
    }

    const match = url.pathname.match(/^\/room\/([A-Z0-9]{1,12})(\/answer)?$/i);
    if (match) {
      const code = match[1].toUpperCase();
      const room = env.ROOMS.get(env.ROOMS.idFromName(code));
      const path = match[2] ? '/answer' : '/offer';
      const res = await room.fetch(`https://room${path}`, {
        method: request.method,
        body: request.method === 'POST' ? await request.text() : undefined,
      });
      return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json', ...cors(env) } });
    }

    if (url.pathname === '/health') return json(env, { ok: true });
    return json(env, { ok: false, error: 'no such route' }, 404);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

    if (url.pathname === '/put') {
      const { offer } = await request.json();
      await this.state.storage.put('offer', offer);
      // The room deletes itself rather than waiting to be collected. Without
      // this it is storage — and a signalling service that accumulates rows is
      // a signalling service somebody is paying for.
      await this.state.storage.setAlarm(Date.now() + TTL_MS);
      return reply({ ok: true });
    }

    if (url.pathname === '/offer') {
      const offer = await this.state.storage.get('offer');
      if (!offer) return reply({ ok: false, error: 'That code has expired or was never a room.' }, 404);
      return reply({ ok: true, offer });
    }

    if (url.pathname === '/answer') {
      if (request.method === 'POST') {
        const { answer } = await request.json().catch(() => ({}));
        if (typeof answer !== 'string' || answer.length > 20000) return reply({ ok: false, error: 'no answer' }, 400);
        // Only if the room is still alive: an answer written into an expired
        // room would resurrect it as a row nobody is waiting on.
        if (!(await this.state.storage.get('offer'))) return reply({ ok: false, error: 'That code has expired.' }, 404);
        await this.state.storage.put('answer', answer);
        return reply({ ok: true });
      }
      const answer = await this.state.storage.get('answer');
      // 200 with `answer: null` rather than a 404, because the host polls this
      // and "not yet" is the ordinary case rather than a failure. A 404 here
      // would be indistinguishable from a code that never existed.
      return reply({ ok: true, answer: answer ?? null });
    }

    return reply({ ok: false }, 404);
  }

  /**
   * Five minutes are up.
   *
   * `deleteAll` and not a flag: what is being deleted is one offer and one
   * answer, and the whole promise of this service is that it keeps neither.
   */
  async alarm() {
    await this.state.storage.deleteAll();
  }
}
