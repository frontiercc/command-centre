// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * One request for what several parts of a page ask for at once.
 *
 * The page shell (sidebar, the mobile bars, the session watcher) and the page itself each ask who
 * is signed in, and several ask for the settings and the alert count, all as the page opens. Sent
 * separately they queue on the server and every one waits for the others. Through this helper
 * the first caller sends the request and the others share its answer; each gets its own copy of
 * the response, so they read it as they always have.
 *
 * An answer is shared only while its request is running and for SHARE_MS after, long enough for
 * the parts of one page to mount, too short to hand anyone a stale answer: a page that changes
 * something and asks again a moment later gets a fresh request.
 */

const SHARE_MS = 2000;

const shared = new Map<string, Promise<Response>>();

export function sharedGet(url: string): Promise<Response> {
  let request = shared.get(url);
  if (!request) {
    request = fetch(url);
    shared.set(url, request);
    const forget = () => setTimeout(() => { if (shared.get(url) === request) shared.delete(url); }, SHARE_MS);
    request.then(forget, () => shared.delete(url));
  }
  return request.then(r => r.clone());
}
