/**
 * The browser half of the refusal rail: what a catch block should put in a
 * toast, and whether it should tell Sentry at all.
 *
 * A refusal reaches the client in one of three shapes — an `ApiResponseError`
 * whose body carried `{ error, code }`, an `ActionResult` with `ok: false`, or
 * a `Refusal` thrown locally — and every one of them is a modelled answer the
 * user can act on, not a fault worth an event.
 */

import { ApiResponseError } from "@/lib/fetch-helpers";

import {
  Refusal,
  isRefusal,
  isRefusalShape,
  type RefusalShape,
} from "./refusal";

export const GENERIC_FAILURE_MESSAGE =
  "Something went wrong on our side. Please try again in a moment.";

function refusalOfActionResult(value: unknown): RefusalShape | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result = value as { ok?: unknown; refusal?: unknown };
  return result.ok === false && isRefusalShape(result.refusal)
    ? result.refusal
    : undefined;
}

/** Rehydrate a wire-format refusal so client code can throw and match on it. */
export function refusalFromShape(
  shape: RefusalShape,
  httpStatus?: number,
): Refusal {
  return new Refusal({
    code: shape.code,
    httpStatus,
    userMessage: shape.message,
  });
}

/** True for anything the server answered on purpose; a 4xx body is an answer. */
export function isExpectedRefusal(error: unknown): boolean {
  if (isRefusal(error)) return true;
  if (error instanceof ApiResponseError) {
    return error.status >= 400 && error.status < 500;
  }
  return refusalOfActionResult(error) !== undefined;
}

/** The sentence a toast shows. Never the raw text of an unknown error. */
export function userMessageFrom(
  error: unknown,
  fallback: string = GENERIC_FAILURE_MESSAGE,
): string {
  if (isRefusal(error)) return error.userMessage;
  if (error instanceof ApiResponseError) {
    // `requireJsonResponse` already lifted the body's `error` into `message`
    // and only falls back to "… (HTTP n)" when the server sent no sentence.
    const detailError =
      typeof error.detail === "object" && error.detail !== null
        ? (error.detail as { error?: unknown }).error
        : undefined;
    if (typeof detailError === "string" && detailError) return detailError;
    return error.message || fallback;
  }
  const actionRefusal = refusalOfActionResult(error);
  if (actionRefusal) return actionRefusal.message;
  return fallback;
}
