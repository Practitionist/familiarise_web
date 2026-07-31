"use client";

import { useQueryClient, type FetchQueryOptions } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import * as Sentry from "@sentry/nextjs";

import {
  createConsultantQueries,
  createConsulteeQueries,
  schedulePrefetch,
} from "@/lib/dashboard-queries";

interface PrefetchDashboardOptions {
  consultantId?: string;
  consulteeId?: string;
  enableAggressivePrefetch?: boolean;
}

// FAQ fetcher — backs the Help tab of the shared Support surface, which both
// the consultant and consultee dashboards mount. Not a dashboard query.
export const fetchHelpFAQs = async () => {
  const { faqs } = await import(
    "@/components/dashboard/shared/support/questions"
  );
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
    async (queries: FetchQueryOptions[], priority: "high" | "medium" | "low" = "medium") => {
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

      // Priority 2: Secondary data (planner). The requests tab self-fetches
      // /api/bookings/* — the old dashboard requests bundle was dead weight
      // (data never read) and has been deleted.
      safePrefetch([queries.planner], "medium");
    } catch (error) {
      console.warn("Consultant data prefetching failed:", error);
      // Best-effort dashboard prefetch — the real useQuery on the actual
      // tab still fetches on demand. Reported for volume visibility only.
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client", expected: "true" }, level: "info" },
      );
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
      // Best-effort dashboard prefetch — see the consultant twin above.
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client", expected: "true" }, level: "info" },
      );
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
    const trackedSet = prefetchedRef.current;
    return () => {
      trackedSet.clear();
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
