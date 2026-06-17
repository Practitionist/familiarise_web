"use client";

import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Factory so every server request gets its OWN client. A module-scope
// singleton on the server is shared across concurrent requests, so one
// user's cached query data can hydrate into another user's SSR render.
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000, // 1 minute
        gcTime: 5 * 60 * 1000, // 5 minutes (renamed from cacheTime in v5)
        retry: 2,
        // Cache-first navigation (perf RCA): the old global `true` refired
        // every mounted query on each window focus — returning to the tab
        // felt like a full reload. Surfaces that genuinely need freshness
        // keep it explicitly: the admin approval/home pages poll via
        // refetchInterval, and PendingPaymentsWidget polls with its own
        // interval — both independent of focus events.
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        refetchOnReconnect: "always",
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  if (typeof window === "undefined") {
    // Server: always a fresh client, never shared across requests.
    return makeQueryClient();
  }
  // Browser: reuse one client so React doesn't recreate it on suspense.
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}

interface ReactQueryProviderProps {
  children: React.ReactNode;
}

export default function ReactQueryProvider({
  children,
}: ReactQueryProviderProps) {
  const [queryClient] = useState(getQueryClient);

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
