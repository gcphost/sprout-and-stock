/**
 * THE FRONT-OF-HOUSE API — the four calls the game makes before there is a
 * socket, and the one place that knows which build is answering them.
 *
 * List the shops, list the worker kinds a card draws a bot from, make one,
 * throw one away. Nothing here is the game: `net` is not open yet, and both
 * screens that run before it is — the loading screen and the front door — read
 * from this instead.
 *
 * Its own module rather than menu.js's private helper, which is what it was
 * until the loader wanted the same transport. The alternative was boot.js
 * importing menu.js for one function reference while menu.js imported boot.js
 * to step aside for it, and a cycle between two screens over a `fetch` is the
 * kind of thing that works until somebody reorders the imports.
 */

/** Over HTTP — the server build, and the default. */
async function httpApi(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: `${res.status}` }));
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `${res.status}`);
  return json;
}

let transport = httpApi;

/**
 * Point the front door at something other than HTTP.
 *
 * The web build has no HTTP and no server; its worker owns the store and
 * answers the same four calls in the same shapes (`LocalNet.api`). A swap here
 * rather than a branch inside `api` for the reason the whole port is built on:
 * the thing being replaced is a *transport*, and the moment a screen can tell
 * which one it has, that screen has learned which build it is in.
 *
 * Deliberately module-level rather than a constructor argument. `Menu` is
 * created in more than one place (the front door, and Leave from the Controls
 * panel), and a parameter is a parameter somebody forgets at one of them — at
 * which point one route into the menu quietly tries to `fetch` in a build with
 * nothing to fetch from. It is also what lets the loading screen borrow it
 * without being handed anything.
 */
export function setMenuApi(fn) {
  transport = fn ?? httpApi;
}

export const api = (method, path, body) => transport(method, path, body);
