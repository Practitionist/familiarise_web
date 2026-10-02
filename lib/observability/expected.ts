/**
 * Marks a thrown error as a modelled outcome rather than a fault so
 * `sentry.shared.config.ts` stamps `expected: true` and downgrades to warning
 * in `beforeSend`.
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
    typeof error !== "function" &&
    typeof error === "object" &&
    (error as Record<symbol, unknown>)[EXPECTED_ERROR] === true
  );
}
