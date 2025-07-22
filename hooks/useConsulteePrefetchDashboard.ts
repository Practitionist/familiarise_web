"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

interface PrefetchConsulteeDashboardOptions {
  consulteeId?: string;
  enableAggressivePrefetch?: boolean;
}

// Individual fetcher functions - can be imported separately
export const fetchConsulteeEvents = async (consulteeId: string) => {
  const response = await fetch(
    `/api/dashboard/consultee/${consulteeId}/events`,
  );
  if (!response.ok)
    throw new Error(`Events fetch failed: ${response.statusText}`);
  const data = await response.json();
  return data.data;
};

export const fetchConsulteeProfile = async (consulteeId: string) => {
  const response = await fetch(`/api/user/consultees/${consulteeId}`);
  if (!response.ok)
    throw new Error(`Consultee profile fetch failed: ${response.statusText}`);
  const data = await response.json();
  return data.data;
};

export const fetchFeedbackData = async () => {
  const response = await fetch(`/api/user/feedbacks`);
  if (!response.ok)
    throw new Error(`Feedback fetch failed: ${response.statusText}`);
  return response.json();
};

export const fetchSupportTickets = async () => {
  const response = await fetch(`/api/user/support-tickets`);
  if (!response.ok)
    throw new Error(`Support tickets fetch failed: ${response.statusText}`);
  return response.json();
};

export const fetchConsulteeMessages = async (consulteeId: string) => {
  // This might need to be updated based on your actual messages API
  const response = await fetch(
    `/api/dashboard/consultee/${consulteeId}/messages`,
  );
  if (!response.ok) {
    // If messages API doesn't exist yet, return empty array
    if (response.status === 404) return [];
    throw new Error(`Messages fetch failed: ${response.statusText}`);
  }
  const data = await response.json();
  return data.data || [];
};

export const fetchUserDetails = async (userId: string) => {
  const response = await fetch(`/api/user/${userId}`);
  if (!response.ok)
    throw new Error(`User details fetch failed: ${response.statusText}`);
  const data = await response.json();
  return data.data;
};

// Query factory functions for consultee dashboard - exported for reuse
export const createConsulteeQueries = (consulteeId: string) => ({
  events: {
    queryKey: ["consultee-events", consulteeId],
    queryFn: () => fetchConsulteeEvents(consulteeId),
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  },
  profile: {
    queryKey: ["consultee-profile", consulteeId],
    queryFn: () => fetchConsulteeProfile(consulteeId),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  },
  feedback: {
    queryKey: ["consultee-feedback"],
    queryFn: () => fetchFeedbackData(),
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  },
  supportTickets: {
    queryKey: ["consultee-support-tickets"],
    queryFn: () => fetchSupportTickets(),
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  },
  messages: {
    queryKey: ["consultee-messages", consulteeId],
    queryFn: () => fetchConsulteeMessages(consulteeId),
    staleTime: 1 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  },
  settings: {
    queryKey: ["consultee-settings", consulteeId],
    queryFn: () => fetchConsulteeProfile(consulteeId), // settings uses same endpoint as profile
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  },
});

// User-level queries (shared across roles) - exported for reuse
export const createUserQueries = (userId: string) => ({
  userDetails: {
    queryKey: ["user-details", userId],
    queryFn: () => fetchUserDetails(userId),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  },
});

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
        await safePrefetch([queries.userDetails], "high");
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

    // Use requestIdleCallback for non-blocking prefetch
    const schedulePretech = (callback: () => void) => {
      if (typeof window !== "undefined" && "requestIdleCallback" in window) {
        window.requestIdleCallback(callback, { timeout: 2000 });
      } else {
        setTimeout(callback, 100);
      }
    };

    // Prefetch critical data immediately when component mounts
    if (consulteeId) {
      schedulePretech(() => prefetchAllConsulteeData());
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
