"use client";

import { useCallback, useMemo, useRef } from "react";

/**
 * Reading `Retry-After` off an `authClient` call.
 *
 * ## Why a hook and not `error.retryAfterSeconds`
 *
 * `authClient.*` resolves failures as `{ data: null, error }`, and that
 * `error` is `@better-fetch/fetch`'s — the parsed JSON body plus `status` and
 * `statusText`, with **no reference to the `Response`**. Headers are therefore
 * unreadable from it, full stop. Two ways out, and this hook takes the first:
 *
 *   1. `fetchOptions.onResponse` is a real, supported hook on this client. It
 *      is registered per call (spread into `signIn.email({ …, fetchOptions })`)
 *      and better-fetch invokes it with `{ response }` *before* the body is
 *      parsed — see `node_modules/better-auth/dist/client/config.mjs`
 *      (`onResponse: options?.fetchOptions?.onResponse`, wired into a
 *      `lifecycle-hooks` plugin) and `node_modules/@better-fetch/fetch/dist/index.js`
 *      (`for (const onResponse of hooks.onResponse)`). The hook is awaited,
 *      so by the time the caller's `await` resolves the header has been read.
 *
 *   2. Our own limiter repeats the number in the 429 body
 *      (`{ code: "RATE_LIMITED", scope, retryAfterSeconds }`), which *does*
 *      reach the client, and `humanizeAuthError` falls back to it on its own.
 *      That covers any caller that forgets this hook.
 *
 * ## Two headers, on purpose
 *
 * `Retry-After` is the header of record for *our* limiter (`lib/rate-limit.ts`).
 * Better Auth's own rate limiter answers `X-Retry-After` instead
 * (`node_modules/better-auth/dist/api/rate-limiter/index.mjs`). Reading only
 * one of them means a BetterAuth-native 429 silently loses its wait time, so
 * both are read.
 *
 * ## RFC 7231 §7.1.3
 *
 * `Retry-After` is `HTTP-date` OR `delay-seconds`. Ours is always seconds, but
 * parsing the date form costs three lines and a wrong "try again in -1
 * seconds" is worse than no number at all.
 */
export interface RetryAfterCapture {
  /**
   * Spread into the call: `signIn.email({ email, password, ...retryAfter.fetchOptions })`.
   */
  fetchOptions: { onResponse: (context: { response: Response }) => void };
  /**
   * Seconds from the most recent response, or `undefined` when the header was
   * absent. Reading clears the slot, so a stale value from a *previous*
   * attempt can never decorate a later, unrelated error.
   */
  take: () => number | undefined;
  /** Drop any captured value without reading it. */
  clear: () => void;
}

function secondsFromHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return undefined;
  return Math.max(0, Math.round((asDate - Date.now()) / 1000));
}

export function useRetryAfterCapture(): RetryAfterCapture {
  // A ref, not state: `onResponse` runs inside better-fetch's promise chain
  // and must not schedule a render of its own — the caller reads the value
  // synchronously after its `await`, and a state update would not have landed
  // by then.
  const captured = useRef<number | undefined>(undefined);

  const take = useCallback(() => {
    const value = captured.current;
    captured.current = undefined;
    return value;
  }, []);

  const clear = useCallback(() => {
    captured.current = undefined;
  }, []);

  // Stable identity so the object can be spread into a call's `fetchOptions`
  // without making the call site a new object on every render.
  const fetchOptions = useMemo<RetryAfterCapture["fetchOptions"]>(
    () => ({
      onResponse: (context: { response: Response }) => {
        const retryAfter =
          secondsFromHeader(context.response.headers.get("Retry-After")) ??
          secondsFromHeader(context.response.headers.get("X-Retry-After"));
        // Only a *limit* answer carries a wait. A 200 that happens to echo the
        // header must not arm the next failure's countdown.
        if (retryAfter !== undefined && context.response.status === 429) {
          captured.current = retryAfter;
        }
      },
    }),
    [],
  );

  return { fetchOptions, take, clear };
}
