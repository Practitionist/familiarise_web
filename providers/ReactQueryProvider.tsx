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
      // Enable refetch on window focus for real-time payment status updates
      // Users will see latest approval payment status when returning to dashboard
      refetchOnWindowFocus: true,
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
