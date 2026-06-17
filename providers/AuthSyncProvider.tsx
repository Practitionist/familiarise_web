"use client";

import { useEffect, useRef } from "react";
import { useSession } from "@/lib/auth-client";
import { postAuthSync, subscribeAuthSync } from "@/lib/auth-broadcast";

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
  const { data: session, refetch } = useSession();
  const prevAuthed = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    return subscribeAuthSync(() => {
      refetch?.();
    });
  }, [refetch]);

  useEffect(() => {
    const authed = !!session?.user;
    // Skip the first render (undefined) so initial hydration doesn't ping.
    if (prevAuthed.current !== undefined && prevAuthed.current !== authed) {
      postAuthSync({ type: authed ? "login" : "logout" });
    }
    prevAuthed.current = authed;
  }, [session]);

  return null;
}
