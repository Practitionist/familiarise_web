"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import {
  createConsulteeQueries,
  createUserQueries,
  batchPrefetch,
  schedulePrefetch,
} from "@/lib/dashboard-queries";


interface PrefetchConsulteeDashboardOptions {
  consulteeId?: string;
  enableAggressivePrefetch?: boolean;
}

export function useConsulteePrefetchDashboard({
  consulteeId,
  enableAggressivePrefetch = true,
}: PrefetchConsulteeDashboardOptions = {}) {
  const queryClient = useQueryClient();
  const prefetchedRef = useRef(new Set<string>());

  // Utility function to safely prefetch queries
  const safePrefetch = useCallback(
    async (queries: any[], priority: "high" | "medium" | "low" = "medium") => {
      const delay =
        priority === "high" ? 0 : priority === "medium" ? 500 : 1000;

      const executePrefetch = async () => {
        const results = await Promise.allSettled(
          queries.map((query) => queryClient.prefetchQuery(query)),
        );

        // Log failures in development
        if (process.env.NODE_ENV === "development") {
          results.forEach((result, index) => {
            if (result.status === "rejected") {
              console.warn(
                `Consultee prefetch failed for query:`,
                queries[index].queryKey,
                result.reason,
              );
            }
          });
        }
      };

      if (delay > 0) {
        setTimeout(executePrefetch, delay);
      } else {
        executePrefetch();
      }
    },
    [queryClient],
  );

  // Prefetch user details
  const prefetchUserData = useCallback(
    async (userId: string) => {
      if (!userId || prefetchedRef.current.has(`user-${userId}`)) {
        return;
      }

      prefetchedRef.current.add(`user-${userId}`);
      const queries = createUserQueries(userId);

      try {
        await safePrefetch([queries.details], "high");
      } catch (error) {
        console.warn("User data prefetching failed:", error);
      }
    },
    [safePrefetch],
  );

  // Enhanced consultee dashboard prefetching
  const prefetchAllConsulteeData = useCallback(async () => {
    if (!consulteeId || prefetchedRef.current.has(`consultee-${consulteeId}`)) {
      return;
    }

    prefetchedRef.current.add(`consultee-${consulteeId}`);
    const queries = createConsulteeQueries(consulteeId);

    try {
      // Priority 1: Critical data (events, profile)
      await safePrefetch([queries.events, queries.profile], "high");

      // Priority 2: Secondary data (feedback, support, messages, settings)
      safePrefetch(
        [
          queries.feedback,
          queries.supportTickets,
          queries.messages,
          queries.settings,
        ],
        "medium",
      );
    } catch (error) {
      console.warn("Consultee data prefetching failed:", error);
    }
  }, [consulteeId, safePrefetch]);

  // Smart hover prefetching for specific tabs
  const prefetchOnTabHover = useCallback(
    (tabType: string) => {
      // Prevent excessive prefetching on rapid hover events
      const throttledPrefetch = (fn: () => void) => {
        const key = `hover-${tabType}-${consulteeId}`;
        if (prefetchedRef.current.has(key)) return;

        prefetchedRef.current.add(key);
        fn();

        // Clear throttle after 5 seconds
        setTimeout(() => prefetchedRef.current.delete(key), 5000);
      };

      if (!consulteeId) return;

      throttledPrefetch(() => {
        const queries = createConsulteeQueries(consulteeId);

        switch (tabType) {
          case "home":
            safePrefetch([queries.events, queries.profile], "high");
            break;
          case "appointments":
            safePrefetch([queries.events], "high");
            break;
          case "history":
            safePrefetch([queries.events], "high");
            break;
          case "messages":
            safePrefetch([queries.messages], "high");
            break;
          case "feedback":
            safePrefetch([queries.feedback, queries.supportTickets], "high");
            break;
          case "settings":
            safePrefetch([queries.settings], "high");
            break;
          case "policy":
            // Policy is likely static, no data prefetching needed
            break;
          default:
            // For other tabs, prefetch profile as fallback
            safePrefetch([queries.profile], "medium");
        }
      });
    },
    [consulteeId, safePrefetch],
  );

  // Auto-prefetch on hook initialization when aggressive prefetching is enabled
  useEffect(() => {
    if (!enableAggressivePrefetch) return;

    // Prefetch critical data immediately when component mounts
    if (consulteeId) {
      schedulePrefetch(() => prefetchAllConsulteeData());
    }
  }, [consulteeId, enableAggressivePrefetch, prefetchAllConsulteeData]);

  // Cleanup function to clear prefetch tracking on unmount
  useEffect(() => {
    return () => {
      prefetchedRef.current.clear();
    };
  }, []);

  return {
    prefetchAllConsulteeData,
    prefetchUserData,
    prefetchOnTabHover,
    // Legacy compatibility
    prefetchConsulteeEvents: prefetchAllConsulteeData,
  };
}
