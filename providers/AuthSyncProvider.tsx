"use client";

import { useCallback, useEffect, useRef } from "react";
import { useSession } from "@/lib/auth-client";
import {
  forgetAuthState,
  readAuthedFlag,
  writeAuthedFlag,
} from "@/lib/auth-remembered";
import { setExpectedUser } from "@/lib/auth/identity-header";
import {
  followSignOutElsewhere,
  leaveEndedSession,
  reloadAsSignedInUser,
  signInHref,
  subscribeToSignOut,
} from "@/lib/auth/sign-out";
import { isProtectedPath } from "@/lib/navigation/protected-routes";
import {
  clearSentryIdentity,
  setSentryIdentity,
} from "@/lib/observability/identity";

/**
 * Keeps this tab's auth state honest. Mounted once at the root; renders
 * nothing. It:
 *   1. Detects revocation and user switches: on focus, visibility and
 *      bfcache restore it refetches the session and asks the server once
 *      (`probeSession`). A confirmed revocation leaves for sign-in with the
 *      reason and the current page as `callbackUrl`; a failed lookup only
 *      refetches. A different user id hard-reloads the tab, so no stale page
 *      or cache acts as the new account.
 *   2. Follows a sign-out in another tab (BroadcastChannel `auth`) without a
 *      second sign-out call.
 *   3. Mirrors the resolved session onto the Sentry user, the remembered
 *      navbar shape and the `X-Expected-User` header for money/IAM writes.
 */

/** Minimum gap between two focus-triggered checks. */
const CHECK_THROTTLE_MS = 30_000;

type Probe =
  | { state: "active"; userId: string | null }
  | { state: "revoked" }
  | { state: "unknown" };

/**
 * One authoritative answer from `/api/user/sessions/current`. Only 401 (no
 * session) and 403 (suspended) mean "revoked"; a 503, any other status or a
 * network error is "unknown" and must never sign anyone out.
 */
async function probeSession(): Promise<Probe> {
  try {
    const res = await fetch("/api/user/sessions/current", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const userId =
        typeof body === "object" &&
        body !== null &&
        "userId" in body &&
        typeof body.userId === "string"
          ? body.userId
          : null;
      return { state: "active", userId };
    }
    if (res.status === 401 || res.status === 403) return { state: "revoked" };
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

export default function AuthSyncProvider() {
  const { data: session, isPending, refetch } = useSession();
  // This tab's previous authed state; resets per page load.
  const previousAuthedRef = useRef<boolean | undefined>(undefined);
  // The account this page load belongs to: the first user it resolved.
  const pageUserIdRef = useRef<string | null>(null);
  const lastCheckRef = useRef<number>(0);
  // Set once this tab is navigating away, so no later check acts twice.
  const leavingRef = useRef(false);
  // Last user stamped onto Sentry, as `id|role`; a role change re-stamps.
  const stampedIdentityRef = useRef<string | null>(null);

  const leave = useCallback((go: () => Promise<void>) => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    void go();
  }, []);

  const reloadAsCurrentUser = useCallback(() => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    reloadAsSignedInUser();
  }, []);

  /**
   * Asks the server whether this tab's session is still alive and whose it
   * is. `afterUnexpectedNull` marks a check triggered by the session store
   * going null, where a 200 means the null was transient.
   */
  const checkSession = useCallback(
    async (afterUnexpectedNull: boolean) => {
      if (!previousAuthedRef.current || leavingRef.current) return;
      const checkedUserId = pageUserIdRef.current;
      const probe = await probeSession();
      if (probe.state === "unknown") {
        refetch?.();
        return;
      }
      if (probe.state === "active") {
        if (probe.userId && checkedUserId && probe.userId !== checkedUserId) {
          reloadAsCurrentUser();
          return;
        }
        if (afterUnexpectedNull) refetch?.();
        return;
      }
      leave(() => leaveEndedSession(signInHref("session-revoked")));
    },
    [leave, refetch, reloadAsCurrentUser],
  );

  // Stamp the acting user onto Sentry. The resolver is the only place SSO and
  // social sign-ins (full-page IdP redirects) are observed, and it also covers
  // expiry and cross-tab sign-out, which never touch the sign-in page.
  useEffect(() => {
    if (isPending) return;
    const user = session?.user as
      | {
          id?: string | null;
          sentryUserId?: string | null;
          role?: string | null;
        }
      | undefined;
    const userId = user?.sentryUserId ?? user?.id ?? null;
    const role = user?.role ?? null;
    const identity = userId ? `${userId}|${role ?? ""}` : null;
    if (identity === stampedIdentityRef.current) return;
    stampedIdentityRef.current = identity;
    if (userId) {
      setSentryIdentity({ userId, role });
    } else {
      // A stranger on a shared machine must not file events as the last user.
      clearSentryIdentity();
    }
  }, [isPending, session]);

  // Session-store transitions: a user switch reloads, an unexpected
  // authed→null is classified, and a remembered-but-expired session on a
  // public page is forgotten quietly.
  useEffect(() => {
    if (isPending) return;

    const nextUserId = session?.user?.id ?? null;
    const authed = nextUserId !== null;
    const prevAuthed = previousAuthedRef.current;

    if (nextUserId && pageUserIdRef.current === null) {
      pageUserIdRef.current = nextUserId;
      setExpectedUser(nextUserId);
    } else if (nextUserId && pageUserIdRef.current !== nextUserId) {
      reloadAsCurrentUser();
      return;
    }

    if (!authed) {
      if (prevAuthed === true) {
        void checkSession(true);
      } else if (prevAuthed === undefined && readAuthedFlag() === true) {
        // Cold load: the session died while the tab was closed. Only a
        // protected page needs the server's verdict; elsewhere, just forget.
        if (isProtectedPath(window.location.pathname)) {
          previousAuthedRef.current = true;
          void checkSession(true);
        } else {
          forgetAuthState();
        }
      }
    }

    previousAuthedRef.current = authed;
    // The navbar's optimistic first paint is reconciled here in both
    // directions; `writeAuthedFlag(false)` drops the cached identity.
    writeAuthedFlag(
      authed,
      authed
        ? {
            name: session?.user?.name ?? null,
            image: session?.user?.image ?? null,
          }
        : null,
    );
  }, [isPending, session, checkSession, reloadAsCurrentUser]);

  // Another tab signed out: follow it without a second sign-out call.
  useEffect(
    () => subscribeToSignOut(() => leave(followSignOutElsewhere)),
    [leave],
  );

  // Revalidate when the user comes back: tab shown, window focused (two
  // visible windows never fire visibilitychange) or a bfcache restore, which
  // skips the throttle because the page may be a signed-out user's history.
  useEffect(() => {
    const revalidate = (force: boolean) => {
      if (previousAuthedRef.current !== true || leavingRef.current) return;
      const now = Date.now();
      if (!force && now - lastCheckRef.current < CHECK_THROTTLE_MS) return;
      lastCheckRef.current = now;
      refetch?.();
      void checkSession(false);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") revalidate(false);
    };
    const onFocus = () => revalidate(false);
    const onPageShow = (event: PageTransitionEvent) =>
      revalidate(event.persisted);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [checkSession, refetch]);

  return null;
}
