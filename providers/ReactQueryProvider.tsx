"use client";

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Create a client
const queryClient = new QueryClient({
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

interface ReactQueryProviderProps {
  children: React.ReactNode;
}

export default function ReactQueryProvider({
  children,
}: ReactQueryProviderProps) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
