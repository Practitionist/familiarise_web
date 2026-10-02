"use client";

import { useCallback, useEffect, useRef } from "react";
import { useSession } from "@/lib/auth-client";
import {
  forgetAuthState,
  readAuthedFlag,
  writeAuthedFlag,
} from "@/lib/auth-remembered";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import {
  clearSentryIdentity,
  setSentryIdentity,
} from "@/lib/observability/identity";

/**
 * Keeps this tab's auth state honest. Mounted once at the root; renders
 * nothing. It:
 *   1. Detects revocation (another tab or device signed out, expiry, a ban):
 *      when the tab becomes visible, and whenever the session unexpectedly
 *      resolves to null, it asks the server once (`probeSession`). Only a
 *      confirmed revocation signs out, with `?reason=session-revoked` so the
 *      sign-in page can say why; a failed lookup refetches instead (#1716).
 *      BetterAuth's client also refetches the session on window focus.
 *   2. Mirrors the resolved session onto the Sentry user and the remembered
 *      navbar shape (`lib/auth-remembered.ts`).
 */

/** Minimum gap between two focus-triggered revocation checks. */
const CHECK_THROTTLE_MS = 30_000;

type ProbeState = "active" | "revoked" | "unknown";

/**
 * One authoritative, three-state answer from `/api/user/sessions/current`.
 * Only 401 (no session) and 403 (suspended) mean "revoked"; a 503, any other
 * status or a network error is "unknown" and must never sign anyone out.
 */
async function probeSession(): Promise<ProbeState> {
  try {
    const res = await fetch("/api/user/sessions/current", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (res.ok) return "active";
    if (res.status === 401 || res.status === 403) return "revoked";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export default function AuthSyncProvider() {
  const { data: session, isPending, refetch } = useSession();
  // This tab's previous authed state; resets per page load.
  const previousAuthedRef = useRef<boolean | undefined>(undefined);
  const previousUserIdRef = useRef<string | undefined>(undefined);
  const lastCheckRef = useRef<number>(0);
  // Last user stamped onto Sentry, as `id|role`, so a re-render that resolves
  // the same session does not re-issue a `setUser` on every re-render — but a
  // ROLE change does re-issue one. The role is part of the identity label, and
  // a promotion or a back-office demotion arrives on the same `user.id`.
  const stampedIdentityRef = useRef<string | null>(null);

  /**
   * One authoritative re-check that answers "was I revoked?".
   *
   * - error (network/503) → could-not-ask, NOT a revocation: refetch
   *   through the normal path and stay put.
   * - 200 → still signed in. After an unexpected null that null was
   *   transient, so refetch to recover; on a plain focus check, do nothing.
   * - 401/403 while we believed we were authed → clean sign-out:
   *   drop the remembered identity, tear down Stream sockets, and land
   *   on sign-in with the reason so the page can say why.
   *
   * Asks `/api/user/sessions/current`, NOT `getSession`: BetterAuth's
   * customSession answers `200 null` for a failed lookup as well as a
   * missing session, so reading that null as "revoked" signed every open
   * tab out during a database blip.
   */
  const classifyUnexpectedSignOut = useCallback(
    async (afterUnexpectedNull: boolean) => {
      if (!previousAuthedRef.current) return;
      // Capture the account this check is FOR: a same-profile sign-in as a
      // different account mid-check must not let a stale answer for the OLD
      // account sign out the NEW one. Compared again before signing out.
      const checkedUserId = previousUserIdRef.current;
      const state = await probeSession();
      if (state === "active") {
        if (afterUnexpectedNull) refetch?.();
        return;
      }
      if (state === "unknown") {
        refetch?.();
        return;
      }
      if (previousUserIdRef.current !== checkedUserId) return;
      forgetAuthState();
      await signOutEverywhere("/auth/signin?reason=session-revoked");
    },
    [refetch],
  );

  // Stamp the acting user onto Sentry. The single source of truth for the
  // CLIENT identity, and it lives here rather than in the sign-in page for two
  // reasons: SSO and social sign-in are full-page redirects through an IdP, so
  // the only place their return trip observes a session is this resolver —
  // which is why the previous `Sentry.setUser` in `app/auth/signin/page.tsx`
  // fired for email/password only and left every SSO and OAuth user
  // unattributed; and this also covers session expiry and cross-tab sign-out,
  // neither of which touches the sign-in page.
  //
  // The wrapped `signOut` in `lib/auth-client.ts` clears the identity on
  // SUCCESS, not eagerly — a failed sign-out leaves the user authenticated, so
  // the id already on the scope is still correct and clearing it would drop the
  // actor for someone who never left (see that file for the full argument). It
  // needs no backstop on the success path, because `signOutEverywhere` and the
  // `onError` paths hard-navigate, which reloads this provider. This effect is
  // the backstop for every path that resolves a session change WITHOUT a
  // sign-out call: session expiry, cross-tab sign-out, SSO, and OAuth.
  useEffect(() => {
    if (isPending) return;
    const userId = session?.user?.id ?? null;
    const role = session?.user?.role ?? null;
    const identity = userId ? `${userId}|${role ?? ""}` : null;
    if (identity === stampedIdentityRef.current) return;
    stampedIdentityRef.current = identity;
    if (userId) {
      setSentryIdentity({ userId, role });
    } else {
      // Without this, the next anonymous session on the same tab keeps the
      // previous account's id — so a stranger on a shared machine files events
      // against the last person who signed in.
      clearSentryIdentity();
    }
  }, [isPending, session]);

  // Unexpected authed→null transitions (revoked elsewhere, expired, or
  // transient) all land here; the classifier tells them apart.
  useEffect(() => {
    // The loading phase is not a transition — wait for the session to resolve.
    if (isPending) return;

    const authed = !!session?.user;
    const nextUserId = session?.user?.id ?? null;
    // Snapshot first: compare against the LAST run's value.
    const prevAuthed = previousAuthedRef.current;
    // Prefer THIS tab's last observed state: the wrapped `signOut` clears the
    // localStorage flag before the network call, so the flag would already
    // read `false`. On first resolution fall back to the flag so a cold tab
    // whose session died while it was closed is still classified (with
    // storage blocked the flag is null and there is nothing to compare).
    const previous = prevAuthed ?? readAuthedFlag();
    if (previous === true && !authed) {
      // Seed the ref BEFORE classifying: it reads the ref synchronously, and
      // on first resolution it is still undefined ("never authed").
      if (prevAuthed === undefined) previousAuthedRef.current = true;
      void classifyUnexpectedSignOut(true);
    }
    previousAuthedRef.current = authed;
    previousUserIdRef.current = nextUserId ?? undefined;
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
  // ask the server whether this session still exists (throttled).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (previousAuthedRef.current !== true) return;
      const now = Date.now();
      if (now - lastCheckRef.current < CHECK_THROTTLE_MS) return;
      lastCheckRef.current = now;
      void classifyUnexpectedSignOut(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [classifyUnexpectedSignOut]);

  return null;
}
