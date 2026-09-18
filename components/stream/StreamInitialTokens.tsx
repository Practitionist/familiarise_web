"use client";

import { createContext, useContext } from "react";
import type { StreamInitialTokens } from "@/lib/stream/initial-tokens";

/**
 * The first Stream tokens, minted on the SERVER by the layout that already
 * resolved the session and handed to the client with the page.
 *
 * The connector used to fetch its first token through a server action on
 * first connect. On a stalled Netlify instance (#1124) that round trip died
 * with "Call to tokenProvider failed ... Failed to fetch" even though the page
 * itself had rendered (FAMILIARISE_WEB-4A, FAMILIARISE_WEB-3N). Minting during
 * the RSC render costs a few milliseconds of HMAC and no extra invocation; the
 * connector seeds its cache from these once and still refreshes through the
 * action when they age out.
 *
 * A context rather than a prop because the consultant and consultee layouts
 * that mount `<StreamProvider>` are client components under
 * `app/dashboard/layout.tsx` and cannot mint.
 *
 * Identity only — never authorization. The token action still binds every
 * refresh to the live session; this only removes the cold hop from the first
 * connect.
 */
const StreamInitialTokensContext = createContext<StreamInitialTokens | null>(
  null,
);

export function StreamInitialTokensProvider({
  tokens,
  children,
}: Readonly<{
  tokens: StreamInitialTokens | null;
  children: React.ReactNode;
}>) {
  return (
    <StreamInitialTokensContext.Provider value={tokens}>
      {children}
    </StreamInitialTokensContext.Provider>
  );
}

export function useStreamInitialTokens(): StreamInitialTokens | null {
  return useContext(StreamInitialTokensContext);
}
