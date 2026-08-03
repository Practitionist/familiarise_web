"use client";

import { createContext, useContext } from "react";

/**
 * The session user's id, resolved on the SERVER and handed to the client
 * dashboard layouts.
 *
 * Those layouts derive identity from `useSession()`, a client hook that is
 * still pending during SSR — so `getEffectiveUserId(session)` is `undefined`
 * there, their `["user-details", userId]` query keys become
 * `["user-details", undefined]`, and a server-side seed of the real key is
 * never read. That is why they render `PersonalDashboardShellSkeleton` instead
 * of `children` server-side, and why no dashboard markup reaches the HTML at
 * all (#1103 measurement: no `<h1`, no nav, FCP ~6s).
 *
 * A context rather than a prop because `app/dashboard/layout.tsx` passes the
 * layouts through `children` and cannot hand them props directly.
 *
 * Identity only — never authorization. The guards still resolve the session
 * themselves; this exists so the FIRST render can name the right query key.
 */
const ServerUserIdContext = createContext<string | undefined>(undefined);

export function ServerUserIdProvider({
  userId,
  children,
}: Readonly<{ userId: string | undefined; children: React.ReactNode }>) {
  return (
    <ServerUserIdContext.Provider value={userId}>
      {children}
    </ServerUserIdContext.Provider>
  );
}

export function useServerUserId(): string | undefined {
  return useContext(ServerUserIdContext);
}
