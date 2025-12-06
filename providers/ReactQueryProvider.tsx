"use client";

import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

interface ReactQueryProviderProps {
  children: React.ReactNode;
}

export default function ReactQueryProvider({
  children,
}: ReactQueryProviderProps) {
  // Create QueryClient inside the component using useState to prevent
  // SSR hydration issues. This ensures a new client is created per
  // request in SSR contexts and persists correctly during hydration.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            gcTime: 5 * 60 * 1000, // 5 minutes (renamed from cacheTime in v5)
            retry: 2,
            refetchOnWindowFocus: false,
            refetchOnMount: false,
            refetchOnReconnect: "always",
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
