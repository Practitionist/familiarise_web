"use client";

import { useQuery } from "@tanstack/react-query";
import * as Sentry from "@sentry/nextjs";
import { useSession } from "@/lib/auth-client";

/**
 * Auto-syncs the current user as a Novu subscriber.
 * Called once per dashboard session. Uses a long staleTime to avoid repeat calls.
 */
export function useNovuSubscriberSync() {
  const { data: session } = useSession();

  return useQuery({
    queryKey: ["novu-subscriber-sync", session?.user?.id],
    queryFn: async () => {
      try {
        const res = await fetch("/api/novu/subscriber", { method: "POST" });
        if (!res.ok) {
          throw new Error("Failed to sync Novu subscriber");
        }
        return await res.json();
      } catch (error) {
        // React Query retries this (retry: 1); a failed sync just delays
        // the subscriber row, nothing user-visible breaks. Captured for
        // retry-volume visibility only.
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          { tags: { subsystem: "novu", expected: "true" }, level: "info" },
        );
        throw error;
      }
    },
    enabled: !!session?.user?.id && !!process.env.NEXT_PUBLIC_NOVU_APP_ID,
    staleTime: 30 * 60 * 1000, // 30 minutes
    gcTime: 60 * 60 * 1000, // 1 hour
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
}
