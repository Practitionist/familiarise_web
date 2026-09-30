"use client";

import { useCallback, useEffect, useRef } from "react";
import { useSession } from "@/lib/auth-client";
import {
  forgetAuthState,
  postAuthSync,
  readAuthedFlag,
  subscribeAuthSync,
  writeAuthedFlag,
} from "@/lib/auth-broadcast";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import {
  clearSentryIdentity,
  setSentryIdentity,
} from "@/lib/observability/identity";

/**
 * Keeps the auth session in sync across browser tabs and devices.
 *
 * Mounted once at the root. It does four things:
 *   1. Listens for login/logout pings from peer tabs and refetches this tab's
 *      session so every `useSession()` consumer re-renders without a reload.
 *      Every tab in a browser profile shares one cookie and therefore one
 *      session, so this ping is all same-browser sync needs.
 *   2. Detects this tab's own logged-out⇄logged-in transition (covers email
 *      sign-in AND the OAuth/SSO redirect, which has no client fetch hook) and
 *      pings peers so they refetch too — including a same-profile sign-in
 *      as a DIFFERENT account (boolean true→true is no transition, so the
 *      user-id change is detected explicitly).
 *   3. Detects revocation from ANOTHER device: when the tab becomes visible,
 *      and whenever the session unexpectedly resolves to null, it asks the
 *      server once (`probeSession`). Only a confirmed revocation signs out,
 *      with `?reason=session-revoked` so the sign-in page can say why; a
 *      failed lookup refetches instead (#1716).
 *   4. Mirrors the resolved session onto the Sentry user, so client-side
 *      events are attributable.
 *
 * Renders nothing. See `lib/auth-broadcast.ts` for why this is needed.
 */

/** Minimum gap between two focus-triggered revocation checks. */
const CHECK_THROTTLE_MS = 30_000;

/**
 * Same-profile second sign-in as a DIFFERENT account: the shared cookie
 * jar now belongs to them, but peer tabs still paint the old account
 * (boolean true→true is no transition). Ping login so peers refetch.
 */
function handleAccountSwitch(
  authed: boolean,
  nextUserId: string | null,
  prevUserId: string | undefined,
): void {
  if (
    authed &&
    nextUserId !== null &&
    prevUserId !== undefined &&
    prevUserId !== nextUserId
  ) {
    postAuthSync({ type: "login" });
  }
}

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
  // In-memory fallback for the previous authed state, used when the cross-tab
  // localStorage flag is unavailable (private mode / blocked storage) so
  // BroadcastChannel sync still works there. Resets per page load.
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

  // Peer-tab login/logout pings: refetch so this tab repaints to the truth.
  useEffect(() => subscribeAuthSync(() => refetch?.()), [refetch]);

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
  // transient) all land here; the classifier tells them apart. The
  // `logout` ping is kept as-is so revoked peers converge by refetch.
  useEffect(() => {
    // The loading phase is not a transition — wait for the session to resolve.
    if (isPending) return;

    const authed = !!session?.user;
    const nextUserId = session?.user?.id ?? null;
    // Snapshot first: the ping decision below must compare against the
    // LAST run's value, not the one recorded this run.
    const prevAuthed = previousAuthedRef.current;
    // Prefer THIS tab's last observed state: the wrapped `signOut` clears the
    // localStorage flag BEFORE the network call (shared-device fail-safe), so
    // by the time the session resolves null the flag already reads `false` and
    // flag-first comparison would swallow the logout ping. The snapshot is
    // immune to that pre-clear; it is undefined only on first resolution,
    // where we fall back to the flag so an OAuth/SSO full-page redirect (new
    // load, no client fetch hook) still pings peers.
    const previous = prevAuthed ?? readAuthedFlag();
    // typeof check: with storage blocked, readAuthedFlag() returns null —
    // `null !== undefined` would treat "no known before-state" as a transition
    // and fire a spurious login/logout ping on first resolution.
    if (typeof previous === "boolean" && previous !== authed) {
      postAuthSync({ type: authed ? "login" : "logout" });
      if (previous && !authed) {
        // Seed the ref BEFORE classifying: it reads the ref
        // synchronously, and on first resolution the ref is still
        // undefined (which reads as "never authed" and aborts the
        // check) — a cold tab whose session died while away would then
        // never classify. Later runs already carry the prior value.
        if (prevAuthed === undefined) previousAuthedRef.current = true;
        void classifyUnexpectedSignOut(true);
      }
    }
    previousAuthedRef.current = authed;
    // Same-profile second sign-in as a DIFFERENT account is no boolean
    // transition — detect the user-id change explicitly (see helper).
    handleAccountSwitch(authed, nextUserId, previousUserIdRef.current);
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
