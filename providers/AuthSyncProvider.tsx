"use client";

import { useEffect, useRef } from "react";
import { useSession } from "@/lib/auth-client";
import {
  postAuthSync,
  readAuthedFlag,
  subscribeAuthSync,
  writeAuthedFlag,
} from "@/lib/auth-broadcast";
import {
  clearSentryIdentity,
  setSentryIdentity,
} from "@/lib/observability/identity";

/**
 * Keeps the auth session in sync across browser tabs.
 *
 * Mounted once at the root. It does three things:
 *   1. Listens for login/logout pings from peer tabs and refetches this tab's
 *      session so every `useSession()` consumer re-renders without a reload.
 *   2. Detects this tab's own logged-out⇄logged-in transition (covers email
 *      sign-in AND the OAuth/SSO redirect, which has no client fetch hook) and
 *      pings peers so they refetch too.
 *   3. Mirrors the resolved session onto the Sentry user, so client-side
 *      events are attributable.
 *
 * Renders nothing. See `lib/auth-broadcast.ts` for why this is needed.
 */
export default function AuthSyncProvider() {
  const { data: session, isPending, refetch } = useSession();
  // In-memory fallback for the previous authed state, used when the cross-tab
  // localStorage flag is unavailable (private mode / blocked storage) so
  // BroadcastChannel sync still works there. Resets per page load.
  const previousAuthedRef = useRef<boolean | undefined>(undefined);
  // Last user stamped onto Sentry, as `id|role`, so a re-render that resolves
  // the same session does not re-issue a `setUser` on every re-render — but a
  // ROLE change does re-issue one. The role is part of the identity label, and
  // a promotion or a back-office demotion arrives on the same `user.id`.
  const stampedIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    return subscribeAuthSync(() => {
      refetch?.();
    });
  }, [refetch]);

  // Stamp the acting user onto Sentry. The single source of truth for the
  // CLIENT identity, and it lives here rather than in the sign-in page for two
  // reasons: SSO and social sign-in are full-page redirects through an IdP, so
  // the only place their return trip observes a session is this resolver —
  // which is why the previous `Sentry.setUser` in `app/auth/signin/page.tsx`
  // fired for email/password only and left every SSO and OAuth user
  // unattributed; and this also covers session expiry and cross-tab sign-out,
  // neither of which touches the sign-in page.
  //
  // The wrapped `signOut` in `lib/auth-client.ts` clears the identity eagerly,
  // because `signOutEverywhere` hard-navigates on success and this effect
  // would never get the chance to run. This effect is the backstop for every
  // path that resolves a session change without a sign-out call.
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
  }, [isPending, session]);

  return null;
}
