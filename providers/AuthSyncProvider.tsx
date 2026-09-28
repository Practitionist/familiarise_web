"use client";

import { useCallback, useEffect, useRef } from "react";
import { getSession, useSession } from "@/lib/auth-client";
import {
  forgetAuthState,
  postAuthSync,
  readAuthedFlag,
  subscribeAuthSync,
  writeAuthedFlag,
  type AuthSyncMessage,
} from "@/lib/auth-broadcast";
import { signOutEverywhere } from "@/lib/auth/sign-out";

/**
 * Keeps the auth session in sync across browser tabs.
 *
 * Mounted once at the root. It does three things:
 *   1. Listens for login/logout pings from peer tabs and refetches this tab's
 *      session so every `useSession()` consumer re-renders without a reload.
 *   2. Detects this tab's own logged-out⇄logged-in transition (covers email
 *      sign-in AND the OAuth/SSO redirect, which has no client fetch hook) and
 *      pings peers so they refetch too.
 *   3. Classifies unexpected sign-outs (#1856): when this tab goes from
 *      authed to null WITHOUT initiating it — a revoked session, an expired
 *      one, or a transient failure — one authoritative re-check tells those
 *      apart. Only a confirmed-gone session signs out (with
 *      `?reason=session-revoked` so the sign-in page can say why); a failed
 *      lookup refetches instead of signing out (#1716, client-side).
 *
 * Revocation triggers feeding the classifier: BetterAuth's 60s interval
 * refetch (`sessionOptions.refetchInterval` in `lib/auth-client.ts` —
 * cross-device, no focus needed, bounded by cookie-cache expiry so up
 * to ~6 min stale), the `session-revoked` BroadcastChannel ping from
 * the tab that performed the revoke (same-browser, instant), a
 * throttled `visibilitychange` re-check (cross-device, within one
 * tab-switch), and the opt-in Redis poll below (cross-device, within
 * the poll interval).
 *
 * Renders nothing. See `lib/auth-broadcast.ts` for why this is needed.
 */

/** Minimum gap between focus-driven authoritative re-checks. */
const FOCUS_CHECK_THROTTLE_MS = 30_000;

/** Per-tab cursor for the opt-in Redis revocation poll. */
const REVSIG_CURSOR_KEY = "familiarise.auth_revsig";

/** 0/disabled by default — the focus check covers revocation; opt in via env. */
const REVSIG_POLL_MS = (() => {
  const raw = process.env.NEXT_PUBLIC_SESSION_REVOCATION_POLL_MS ?? "0";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

function readRevsigCursor(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(REVSIG_CURSOR_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeRevsigCursor(value: number): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(REVSIG_CURSOR_KEY, String(value));
  } catch {
    // Best-effort — a missing cursor just re-baselines on next read.
  }
}

export default function AuthSyncProvider() {
  const { data: session, isPending, refetch } = useSession();
  // In-memory fallback for the previous authed state, used when the cross-tab
  // localStorage flag is unavailable (private mode / blocked storage) so
  // BroadcastChannel sync still works there. Resets per page load.
  const previousAuthedRef = useRef<boolean | undefined>(undefined);
  const lastFocusCheckRef = useRef<number>(0);

  /**
   * One authoritative re-check that answers "was I revoked?".
   *
   * - error (network/503) → could-not-ask, NOT a revocation: refetch
   *   through the normal path and stay put.
   * - user present → the null was a cookie-cache race: refetch to recover.
   * - confirmed null while we believed we were authed → clean sign-out:
   *   drop the remembered identity, tear down Stream sockets, and land
   *   on sign-in with the reason so the page can say why.
   */
  const classifyUnexpectedSignOut = useCallback(async () => {
    if (!previousAuthedRef.current) return;
    let result: Awaited<ReturnType<typeof getSession>>;
    try {
      result = await getSession({ query: { disableCookieCache: true } });
    } catch {
      refetch?.();
      return;
    }
    if (result.error) {
      refetch?.();
      return;
    }
    if (result.data?.user) {
      refetch?.();
      return;
    }
    forgetAuthState();
    await signOutEverywhere("/auth/signin?reason=session-revoked");
  }, [refetch]);

  // Peer-tab pings. `session-revoked` comes from the tab that performed
  // the revoke and short-circuits the wait for focus: classify now.
  useEffect(() => {
    const onMessage = (message: AuthSyncMessage) => {
      if (message.type === "session-revoked") {
        void classifyUnexpectedSignOut();
        return;
      }
      refetch?.();
    };
    return subscribeAuthSync(onMessage);
  }, [refetch, classifyUnexpectedSignOut]);

  // Unexpected authed→null transitions (revoked elsewhere, expired, or
  // transient) all land here; the classifier tells them apart. The
  // `logout` ping is kept as-is so revoked peers converge by refetch.
  useEffect(() => {
    // The loading phase is not a transition — wait for the session to resolve.
    if (isPending) return;

    const authed = !!session?.user;
    // Prefer THIS tab's last observed state: the wrapped `signOut` clears the
    // localStorage flag BEFORE the network call (shared-device fail-safe), so
    // by the time the session resolves null the flag already reads `false` and
    // flag-first comparison would swallow the logout ping. The in-memory ref
    // is immune to that pre-clear; it is undefined only on first resolution,
    // where we fall back to the flag so an OAuth/SSO full-page redirect (new
    // load, no client fetch hook) still pings peers.
    const previous = previousAuthedRef.current ?? readAuthedFlag();
    // typeof check: with storage blocked, readAuthedFlag() returns null —
    // `null !== undefined` would treat "no known before-state" as a transition
    // and fire a spurious login/logout ping on first resolution.
    if (typeof previous === "boolean" && previous !== authed) {
      postAuthSync({ type: authed ? "login" : "logout" });
      if (previous && !authed) void classifyUnexpectedSignOut();
    }
    previousAuthedRef.current = authed;
    // Also the reconciliation point for the navbar's optimistic first paint:
    // a resolved session rewrites the remembered shape in BOTH directions, and
    // `writeAuthedFlag(false)` drops the cached identity outright.
    writeAuthedFlag(
      authed,
      authed
        ? {
            name: session?.user?.name ?? null,
            image: session?.user?.image ?? null,
          }
        : null,
    );
  }, [isPending, session, classifyUnexpectedSignOut]);

  // Cross-device, within one tab-switch: when the tab becomes visible,
  // run the authoritative check (throttled — it bypasses the cookie
  // cache and re-runs customSession enrichment, so it is NOT cheap).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (previousAuthedRef.current !== true) return;
      const now = Date.now();
      if (now - lastFocusCheckRef.current < FOCUS_CHECK_THROTTLE_MS) return;
      lastFocusCheckRef.current = now;
      void classifyUnexpectedSignOut();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [classifyUnexpectedSignOut]);

  // Cross-device, within the poll interval: compare the per-user
  // revocation counter against this tab's cursor. Opt-in only
  // (NEXT_PUBLIC_SESSION_REVOCATION_POLL_MS, default 0 = off). A move
  // means "something was revoked" — the classifier confirms whether it
  // was US. Strictly-greater comparison: a Redis restart resets the
  // counter and must not mass-sign-out users.
  useEffect(() => {
    if (REVSIG_POLL_MS <= 0) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (previousAuthedRef.current !== true) return;
      void (async () => {
        try {
          const res = await fetch("/api/user/sessions/revocation-signal", {
            credentials: "same-origin",
          });
          if (!res.ok) {
            // A 401/403 here means OUR session is gone (requireApiAuth
            // answers before the route reads the counter) — classify now
            // instead of sitting stale until the next focus event. Any
            // other status (503, 500, network) is "could not ask", never
            // a revocation (#1716): stay put.
            if (res.status === 401 || res.status === 403) {
              await classifyUnexpectedSignOut();
            }
            return;
          }
          const { signal } = (await res.json()) as { signal: unknown };
          if (typeof signal !== "number") return;
          const cursor = readRevsigCursor();
          if (cursor === null) {
            writeRevsigCursor(signal);
            return;
          }
          if (signal > cursor) {
            writeRevsigCursor(signal);
            await classifyUnexpectedSignOut();
          }
        } catch {
          // Best-effort — the focus check remains the source of truth.
        }
      })();
    }, REVSIG_POLL_MS);
    return () => window.clearInterval(id);
  }, [classifyUnexpectedSignOut]);

  return null;
}
