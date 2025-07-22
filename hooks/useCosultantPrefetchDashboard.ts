"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

interface PrefetchDashboardOptions {
  consultantId?: string;
  consulteeId?: string;
  enableAggressivePrefetch?: boolean;
}

// Individual fetcher functions - can be imported separately
export const fetchConsultantDashboard = async (consultantId: string) => {
  const response = await fetch(`/api/dashboard/consultant/${consultantId}`);
  if (!response.ok)
    throw new Error(`Dashboard fetch failed: ${response.statusText}`);
  const data = await response.json();
  return data.data;
};

export const fetchConsultantAppointments = async (consultantId: string) => {
  const response = await fetch(
    `/api/slots/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`,
  );
  if (!response.ok)
    throw new Error(`Appointments fetch failed: ${response.statusText}`);
  const data = await response.json();
  return data.data;
};

export const fetchConsultantDetails = async (consultantId: string) => {
  const response = await fetch(`/api/user/consultants/${consultantId}`);
  if (!response.ok)
    throw new Error(`Consultant details fetch failed: ${response.statusText}`);
  const data = await response.json();
  return data.data;
};

export const fetchConsultantRequests = async (consultantId: string) => {
  const response = await fetch(
    `/api/dashboard/consultant/${consultantId}/requests`,
  );
  if (!response.ok)
    throw new Error(`Requests fetch failed: ${response.statusText}`);
  const data = await response.json();
  return data.data;
};

export const fetchConsultantPlanner = async (consultantId: string) => {
  const response = await fetch(
    `/api/dashboard/consultant/${consultantId}/planner`,
  );
  if (!response.ok)
    throw new Error(`Planner fetch failed: ${response.statusText}`);
  const data = await response.json();
  return data.data;
};

export const fetchHelpFAQs = async () => {
  const { faqs } = await import(
    "../app/dashboard/consultant/[consultantId]/(features)/help/questions"
  );
  return faqs;
};

// Query factory functions for better organization - exported for reuse
export const createConsultantQueries = (consultantId: string) => ({
  dashboard: {
    queryKey: ["consultant-dashboard", consultantId],
    queryFn: () => fetchConsultantDashboard(consultantId),
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  },
  appointments: {
    queryKey: ["appointments", consultantId],
    queryFn: () => fetchConsultantAppointments(consultantId),
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  },
  details: {
    queryKey: ["consultant-details", consultantId],
    queryFn: () => fetchConsultantDetails(consultantId),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  },
  requests: {
    queryKey: ["requests", consultantId],
    queryFn: () => fetchConsultantRequests(consultantId),
    staleTime: 1 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  },
  planner: {
    queryKey: ["planner", consultantId],
    queryFn: () => fetchConsultantPlanner(consultantId),
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  },
});

export const createConsulteeQueries = (consulteeId: string) => ({
  events: {
    queryKey: ["consultee-events", consulteeId],
    queryFn: async () => {
      const response = await fetch(
        `/api/dashboard/consultee/${consulteeId}/events`,
      );
      if (!response.ok)
        throw new Error(`Events fetch failed: ${response.statusText}`);
      const data = await response.json();
      return data.data;
    },
    staleTime: 2 * 60 * 1000,
  },
  feedback: {
    queryKey: ["feedback"],
    queryFn: async () => {
      const response = await fetch(`/api/user/feedbacks`);
      if (!response.ok)
        throw new Error(`Feedback fetch failed: ${response.statusText}`);
      return response.json();
    },
    staleTime: 2 * 60 * 1000,
  },
  supportTickets: {
    queryKey: ["support-tickets"],
    queryFn: async () => {
      const response = await fetch(`/api/user/support-tickets`);
      if (!response.ok)
        throw new Error(`Support tickets fetch failed: ${response.statusText}`);
      return response.json();
    },
    staleTime: 2 * 60 * 1000,
  },
});

// Static queries (FAQ, help, etc.) - exported for reuse
export const staticQueries = {
  help: {
    queryKey: ["help-faqs"],
    queryFn: fetchHelpFAQs,
    staleTime: Infinity, // Static data never becomes stale
    gcTime: Infinity,
    retry: false,
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

    // Use requestIdleCallback for non-blocking prefetch
    const schedulePretech = (callback: () => void) => {
      if (typeof window !== "undefined" && "requestIdleCallback" in window) {
        window.requestIdleCallback(callback, { timeout: 2000 });
      } else {
        setTimeout(callback, 100);
      }
    };

    // Prefetch critical data immediately when component mounts
    if (consultantId) {
      schedulePretech(() => prefetchAllConsultantData());
    }
    if (consulteeId) {
      schedulePretech(() => prefetchAllConsulteeData());
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
