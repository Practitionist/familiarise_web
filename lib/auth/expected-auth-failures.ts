/**
 * Which auth failures are ANSWERS rather than faults, and how to say so.
 *
 * ## Why this module exists
 *
 * The failure-modes matrix (row 19, `docs/authentication/betterauth/09-failure-modes.md`)
 * records that `lib/observability/expected.ts` was defined, honoured in
 * `beforeSend`, and called from nowhere — so every expected auth failure pages
 * on-call while behaving correctly. The marker is only half the job; deciding
 * *which* failures deserve it is the half that has to be one place, because
 * "a thrown fetch on the sign-in page" is asserted in two page components and a
 * third reader will otherwise re-derive the test and get it wrong in the
 * permissive direction.
 *
 * ## The narrowness rule
 *
 * The marker's cost when applied too widely is silent: a genuine bug at
 * `warning` is an alert that never fires. So every predicate here is a *positive*
 * test for one recognisable failure shape, never a catch-all, and the callers
 * keep their existing fallback for anything it does not recognise.
 *
 * ## What is deliberately NOT here
 *
 * `isUnreachableTransportError` does not treat a 5xx as unreachable. A 5xx is an
 * HTTP response *we* produced, which means a handler ran, which means the
 * platform delivered the request — the opposite of the stall in row 6, and very
 * often a real server fault worth a page. Only a failure that never reached the
 * service qualifies.
 */

import { markExpected } from "@/lib/observability/expected";

/**
 * True when the failure is recognisably "the request never reached the service".
 *
 * ## The two shapes, and why both are needed
 *
 * 1. **`fetch` rejected** (`TypeError: Failed to fetch`, or the same text as a
 *    message). The browser never got a response. This is the Netlify
 *    cold-instance stall of failure-modes row 6 as the customer experiences it:
 *    ~25-28 s, then a thrown fetch, then `status 0` in `humanizeAuthError`'s
 *    vocabulary, whose copy is `UNREACHABLE` — "nothing was changed".
 *
 * 2. **A response with `status === 0`.** `authClient` resolves API failures as
 *    `{ data: null, error }` where `error.status` is the HTTP status, and a
 *    non-response (opaque CORS failure, a `net::ERR_*` the browser does not
 *    surface to JS) surfaces as `0`. Treats the *shape* of the failure, not its
 *    message, so a reworded browser string does not silently start paging.
 *
 * ## Why the message test is bounded rather than a substring sweep
 *
 * `Failed to fetch` and `NetworkError when attempting to fetch resource` are the
 * two strings every engine has shipped for years, and both arrive as a
 * `TypeError`. A prefix match on `fetch` alone would also match a genuine
 * `TypeError: x.fetch is not a function` — our own bug, on the same object
 * shape — so the predicate requires the failure to look like the platform's
 * fetch rejection and nothing else.
 */
export function isUnreachableTransportError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;

  const candidate = error as {
    status?: unknown;
    message?: unknown;
    name?: unknown;
  };

  // A status of exactly 0 is `net::ERR_*` / opaque-failure, never a real
  // response: HTTP has no status 0, so nothing we produced can carry it.
  if (candidate.status === 0) return true;

  if (typeof candidate.message !== "string") return false;
  const message = candidate.message.toLowerCase();
  if (!message.includes("fetch")) return false;
  if (
    message.includes("failed to fetch") ||
    message.includes("networkerror when attempting to fetch resource")
  ) {
    return true;
  }
  // `TypeError` is the platform's constructor for a rejected fetch in every
  // engine. A non-fetch `TypeError` cannot carry these messages, so requiring
  // the name costs nothing and keeps `x.fetch is not a function` out.
  return candidate.name === "TypeError";
}

/**
 * Mark `error` expected **only** if it is an unreachable-transport failure.
 *
 * Returns the same object either way so it composes into a capture expression,
 * and reports whether it marked so a caller can count the unmarked case
 * separately rather than assuming every failure on this path was the stall.
 *
 * Un-marked is the safe default. A failure we do not recognise keeps its error
 * level, because the failure mode of a *too-narrow* predicate is one missing
 * alert and the failure mode of a *too-wide* one is a bug nobody is paged for.
 */
export function markExpectedUnreachable<E>(error: E): {
  error: E;
  marked: boolean;
} {
  if (!isUnreachableTransportError(error)) return { error, marked: false };
  // The cast is the point of the function rather than a hole in it: the marker
  // can only ride on an object, and the predicate has already established that
  // this value is one (a bare string or number cannot carry `status: 0`, and
  // `markExpected` would have nothing to stamp).
  return {
    error: markExpected(error as unknown as Error) as unknown as E,
    marked: true,
  };
}
