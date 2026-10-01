/**
 * Marks a thrown error as a modelled outcome rather than a fault.
 *
 * `reportSentryError` tags its own captures, but an error that escapes a server
 * action or a route handler is captured by Next's `onRequestError` hook, which
 * takes no per-call options. The marker therefore rides on the error object and
 * `sentry.shared.config.ts` stamps `expected:true` in `beforeSend`, so a guard
 * that fired by design lands at warning instead of paging (FAMILIARISE_WEB-10).
 *
 * Deliberately dependency-free: the Sentry config imports it during init, and a
 * non-enumerable symbol keeps the marker out of JSON serialisation and out of
 * anything that spreads the error.
 *
 * ## Where it works, and where it does not (verified, not assumed)
 *
 * The mechanism is one line in the SDK: `Scope.captureException` puts the
 * exception it was handed on the event hint as `originalException`
 * (`@sentry/core@10.59.0`, `build/cjs/scope.js:481-497`), and `beforeSend`
 * reads `hint.originalException`. So the marker is honoured by **every** route
 * that captures the marked object as the exception:
 *
 *   - Next's `onRequestError` (via `Sentry.captureRequestError`,
 *     `common/captureRequestError.js:21`) — the reason this module exists.
 *   - A direct `Sentry.captureException(markedError)`.
 *   - `reportSentryError(markedError, …)`, because `normaliseError` returns an
 *     `Error` unchanged and the same object is captured.
 *
 * Two shapes it does NOT reach, and both are real traps:
 *
 *   - `captureMessage(string)`. The hint's `originalException` is the string, so
 *     there is no object to read the symbol off. A refusal reported as a message
 *     has to carry `expected: true` in its own options or it pages.
 *   - `reportSentryError(nonError, …)`. `normaliseError` builds a *fresh* `Error`
 *     from a thrown string or plain object, so a marker on the original is gone.
 *     (`markExpected` takes an `Error` for the same reason — there is nothing
 *     object-shaped to stamp.)
 *
 * `beforeSend` only ever re-levels; it never drops. An expected event still
 * arrives, still searchable, still a trickle rather than a page — which is what
 * makes marking safe to apply to a failure that can repeat per request.
 */

const EXPECTED_ERROR = Symbol.for("familiarise.observability.expectedError");

export function markExpected<E extends Error>(error: E): E {
  Object.defineProperty(error, EXPECTED_ERROR, {
    value: true,
    enumerable: false,
  });
  return error;
}

export function isExpectedError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as Record<symbol, unknown>)[EXPECTED_ERROR] === true
  );
}
