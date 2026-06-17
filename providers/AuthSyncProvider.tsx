"use client";

import { useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import {
  postAuthSync,
  readAuthedFlag,
  subscribeAuthSync,
  writeAuthedFlag,
} from "@/lib/auth-broadcast";

/**
 * Keeps the auth session in sync across browser tabs.
 *
 * Mounted once at the root. It does two things:
 *   1. Listens for login/logout pings from peer tabs and refetches this tab's
 *      session so every `useSession()` consumer re-renders without a reload.
 *   2. Detects this tab's own logged-out⇄logged-in transition (covers email
 *      sign-in AND the OAuth/SSO redirect, which has no client fetch hook) and
 *      pings peers so they refetch too.
 *
 * Renders nothing. See `lib/auth-broadcast.ts` for why this is needed.
 */
export default function AuthSyncProvider() {
  const { data: session, isPending, refetch } = useSession();

  useEffect(() => {
    return subscribeAuthSync(() => {
      refetch?.();
    });
  }, [refetch]);

  useEffect(() => {
    // The loading phase is not a transition — wait for the session to resolve.
    if (isPending) return;

    const authed = !!session?.user;
    // Compare against the cross-tab flag, not just this tab's previous render:
    // a reload of an already-authed user matches the flag and stays silent,
    // while a genuine login (incl. the OAuth/SSO redirect, which has no client
    // fetch hook) flips it and pings peers. Skip when the flag is unset (first
    // ever load) so we never broadcast without a real before-state.
    const previous = readAuthedFlag();
    if (previous !== null && previous !== authed) {
      postAuthSync({ type: authed ? "login" : "logout" });
    }
    writeAuthedFlag(authed);
  }, [isPending, session]);

  return null;
}
