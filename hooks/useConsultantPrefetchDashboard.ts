"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import {
  createConsultantQueries,
  createConsulteeQueries,
  batchPrefetch,
  schedulePrefetch,
} from "@/lib/dashboard-queries";


interface PrefetchDashboardOptions {
  consultantId?: string;
  consulteeId?: string;
  enableAggressivePrefetch?: boolean;
}

// FAQ fetcher — specific to consultant help page, not a dashboard query
export const fetchHelpFAQs = async () => {
  const { faqs } =
    await import("../app/dashboard/consultant/[consultantId]/(features)/help/questions");
  return faqs;
};

// Static queries (FAQ, help, etc.) — exported for reuse
export const staticQueries = {
  help: {
    queryKey: ["help-faqs"],
    queryFn: fetchHelpFAQs,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false as const,
  },
};

export function usePrefetchDashboard({
  consultantId,
  consulteeId,
  enableAggressivePrefetch = true,
}: PrefetchDashboardOptions = {}) {
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
                `Prefetch failed for query:`,
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

  // Enhanced consultant dashboard prefetching
  const prefetchAllConsultantData = useCallback(async () => {
    if (
      !consultantId ||
      prefetchedRef.current.has(`consultant-${consultantId}`)
    ) {
      return;
    }

    prefetchedRef.current.add(`consultant-${consultantId}`);
    const queries = createConsultantQueries(consultantId);

    try {
      // Priority 1: Critical data (home, appointments, details)
      await safePrefetch(
        [
          queries.dashboard,
          queries.appointments,
          queries.details,
          staticQueries.help,
        ],
        "high",
      );

      // Priority 2: Secondary data (requests, planner)
      safePrefetch([queries.requests, queries.planner], "medium");
    } catch (error) {
      console.warn("Consultant data prefetching failed:", error);
    }
  }, [consultantId, safePrefetch]);

  // Enhanced consultee dashboard prefetching
  const prefetchAllConsulteeData = useCallback(async () => {
    if (!consulteeId || prefetchedRef.current.has(`consultee-${consulteeId}`)) {
      return;
    }

    prefetchedRef.current.add(`consultee-${consulteeId}`);
    const queries = createConsulteeQueries(consulteeId);

    try {
      // All consultee data has similar priority
      await safePrefetch(
        [queries.events, queries.feedback, queries.supportTickets],
        "high",
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
        const key = `hover-${tabType}`;
        if (prefetchedRef.current.has(key)) return;

        prefetchedRef.current.add(key);
        fn();

        // Clear throttle after 5 seconds
        setTimeout(() => prefetchedRef.current.delete(key), 5000);
      };

      throttledPrefetch(() => {
        if (consultantId) {
          const queries = createConsultantQueries(consultantId);

          switch (tabType) {
            case "home":
              safePrefetch([queries.dashboard], "high");
              break;
            case "appointments":
              safePrefetch([queries.appointments], "high");
              break;
            case "planner":
              safePrefetch([queries.planner], "high");
              break;
            case "requests":
              safePrefetch([queries.requests], "high");
              break;
            default:
              // For other tabs, prefetch consultant details as fallback
              safePrefetch([queries.details], "medium");
          }
        }

        if (consulteeId) {
          const queries = createConsulteeQueries(consulteeId);

          switch (tabType) {
            case "home":
            case "appointments":
            case "history":
              safePrefetch([queries.events], "high");
              break;
            case "feedback":
              safePrefetch([queries.feedback], "high");
              break;
          }
        }
      });
    },
    [consultantId, consulteeId, safePrefetch],
  );

  // Auto-prefetch on hook initialization when aggressive prefetching is enabled
  useEffect(() => {
    if (!enableAggressivePrefetch) return;

    // Prefetch critical data immediately when component mounts
    if (consultantId) {
      schedulePrefetch(() => prefetchAllConsultantData());
    }
    if (consulteeId) {
      schedulePrefetch(() => prefetchAllConsulteeData());
    }
  }, [
    consultantId,
    consulteeId,
    enableAggressivePrefetch,
    prefetchAllConsultantData,
    prefetchAllConsulteeData,
  ]);

  // Cleanup function to clear prefetch tracking on unmount
  useEffect(() => {
    return () => {
      prefetchedRef.current.clear();
    };
  }, []);

  return {
    prefetchAllConsultantData,
    prefetchAllConsulteeData,
    prefetchOnTabHover,
    // Legacy compatibility
    prefetchConsultantDashboard: prefetchAllConsultantData,
    prefetchConsulteeEvents: prefetchAllConsulteeData,
  };
}
