/**
 * Predicates for distinguishing client-side transport failures (where the
 * request never reached the server) from server/application errors.
 */

import { markExpected } from "@/lib/observability/expected";

/**
 * True when the failure indicates the request never reached the service
 * (`status === 0` or browser fetch network rejection).
 */
export function isUnreachableTransportError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;

  const candidate = error as { status?: unknown; message?: unknown };
  if (candidate.status === 0) return true;

  if (typeof candidate.message !== "string") return false;
  const message = candidate.message.toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror when attempting to fetch resource")
  );
}

/**
 * Mark `error` expected only if it is an unreachable-transport failure.
 */
export function markExpectedUnreachable<E>(error: E): {
  error: E;
  marked: boolean;
} {
  if (!isUnreachableTransportError(error)) return { error, marked: false };
  return {
    error: markExpected(error as unknown as Error) as unknown as E,
    marked: true,
  };
}
