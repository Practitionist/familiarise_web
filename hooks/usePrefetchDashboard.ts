"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

interface PrefetchDashboardOptions {
  consultantId?: string;
  consulteeId?: string;
  enableAggressivePrefetch?: boolean;
}

export function usePrefetchDashboard({
  consultantId,
  consulteeId,
  enableAggressivePrefetch = true,
}: PrefetchDashboardOptions = {}) {
  const queryClient = useQueryClient();
  const prefetchedRef = useRef(new Set<string>());

  // Enhanced consultant dashboard prefetching - ALL tabs
  const prefetchAllConsultantData = useCallback(async () => {
    if (
      !consultantId ||
      prefetchedRef.current.has(`consultant-${consultantId}`)
    )
      return;

    prefetchedRef.current.add(`consultant-${consultantId}`);

    try {
      // Prefetch all consultant endpoints in parallel with Promise.allSettled for resilience
      await Promise.allSettled([
        // Home dashboard data (priority 1)
        queryClient.prefetchQuery({
          queryKey: ["consultant-dashboard", consultantId],
          queryFn: async () => {
            const response = await fetch(
              `/api/dashboard/consultant/${consultantId}`,
            );
            if (!response.ok)
              throw new Error(
                `Failed to fetch dashboard data: ${response.statusText}`,
              );
            const data = await response.json();
            return data.data;
          },
          staleTime: 2 * 60 * 1000,
        }),

        // Appointments data (priority 1)
        queryClient.prefetchQuery({
          queryKey: ["appointments", consultantId],
          queryFn: async () => {
            const response = await fetch(
              `/api/slots/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`,
            );
            if (!response.ok)
              throw new Error(
                `Failed to fetch appointments: ${response.statusText}`,
              );
            const data = await response.json();
            return data.data;
          },
          staleTime: 2 * 60 * 1000,
        }),

        // Consultant details for chats (priority 1)
        queryClient.prefetchQuery({
          queryKey: ["consultant-details", consultantId],
          queryFn: async () => {
            const response = await fetch(
              `/api/user/consultants/${consultantId}`,
            );
            if (!response.ok)
              throw new Error(
                `Failed to fetch consultant details: ${response.statusText}`,
              );
            const data = await response.json();
            return data.data;
          },
          staleTime: 5 * 60 * 1000,
        }),

        // Documents data (priority 2)
        queryClient.prefetchQuery({
          queryKey: ["documents", consultantId],
          queryFn: async () => {
            // Documents currently return empty array, but we prefetch for consistency
            return [];
          },
          staleTime: 2 * 60 * 1000,
        }),

        // Help/FAQ data (priority 2 - static data)
        queryClient.prefetchQuery({
          queryKey: ["help-faqs"],
          queryFn: async () => {
            // Static FAQ data - import directly
            const { faqs } = await import(
              "../app/dashboard/consultant/[consultantId]/(features)/help/questions"
            );
            return faqs;
          },
          staleTime: Infinity, // Static data never becomes stale
        }),

        // Settings data (priority 2)
        queryClient.prefetchQuery({
          queryKey: ["consultant-settings", consultantId],
          queryFn: async () => {
            const response = await fetch(
              `/api/user/consultants/${consultantId}`,
            );
            if (!response.ok)
              throw new Error(
                `Failed to fetch consultant settings: ${response.statusText}`,
              );
            const data = await response.json();
            return data.data;
          },
          staleTime: 5 * 60 * 1000,
        }),
      ]);

      // Priority 3: Heavy data - prefetch after a delay
      setTimeout(() => {
        Promise.allSettled([
          // Requests data (heavy - 6 API calls consolidated)
          queryClient.prefetchQuery({
            queryKey: ["requests", consultantId],
            queryFn: async () => {
              const response = await fetch(
                `/api/dashboard/consultant/${consultantId}/requests`,
              );
              if (!response.ok)
                throw new Error(
                  `Failed to fetch requests: ${response.statusText}`,
                );
              const data = await response.json();
              return data.data;
            },
            staleTime: 1 * 60 * 1000,
          }),

          // Planner data (heavy - includes participant counts)
          queryClient.prefetchQuery({
            queryKey: ["planner", consultantId],
            queryFn: async () => {
              const response = await fetch(
                `/api/dashboard/consultant/${consultantId}/planner`,
              );
              if (!response.ok)
                throw new Error(
                  `Failed to fetch planner: ${response.statusText}`,
                );
              const data = await response.json();
              return data.data;
            },
            staleTime: 2 * 60 * 1000,
          }),
        ]);
      }, 1000); // 1 second delay for heavy data
    } catch (error) {
      console.warn("Some consultant data prefetching failed:", error);
      // Don't throw - prefetching failures should not break the app
    }
  }, [queryClient, consultantId]);

  // Enhanced consultee dashboard prefetching - ALL tabs
  const prefetchAllConsulteeData = useCallback(async () => {
    if (!consulteeId || prefetchedRef.current.has(`consultee-${consulteeId}`))
      return;

    prefetchedRef.current.add(`consultee-${consulteeId}`);

    try {
      // Prefetch all consultee endpoints in parallel
      await Promise.allSettled([
        // Home & Appointments & History data (priority 1 - shared events data)
        queryClient.prefetchQuery({
          queryKey: ["consultee-events", consulteeId],
          queryFn: async () => {
            const response = await fetch(
              `/api/dashboard/consultee/${consulteeId}/events`,
            );
            if (!response.ok)
              throw new Error(`Failed to fetch events: ${response.statusText}`);
            const data = await response.json();
            return data.data;
          },
          staleTime: 2 * 60 * 1000,
        }),

        // Feedback data (priority 2)
        queryClient.prefetchQuery({
          queryKey: ["feedback"],
          queryFn: async () => {
            const response = await fetch(`/api/user/feedbacks`);
            if (!response.ok)
              throw new Error(
                `Failed to fetch feedback: ${response.statusText}`,
              );
            return response.json();
          },
          staleTime: 2 * 60 * 1000,
        }),

        // Support tickets data (priority 2)
        queryClient.prefetchQuery({
          queryKey: ["support-tickets"],
          queryFn: async () => {
            const response = await fetch(`/api/user/support-tickets`);
            if (!response.ok)
              throw new Error(
                `Failed to fetch support tickets: ${response.statusText}`,
              );
            return response.json();
          },
          staleTime: 2 * 60 * 1000,
        }),
      ]);
    } catch (error) {
      console.warn("Some consultee data prefetching failed:", error);
      // Don't throw - prefetching failures should not break the app
    }
  }, [queryClient, consulteeId]);

  // Smart hover prefetching for specific tabs
  const prefetchOnTabHover = useCallback(
    (tabType: string) => {
      switch (tabType) {
        case "home":
          if (consultantId) {
            queryClient.prefetchQuery({
              queryKey: ["consultant-dashboard", consultantId],
              queryFn: async () => {
                const response = await fetch(
                  `/api/dashboard/consultant/${consultantId}`,
                );
                if (!response.ok)
                  throw new Error(
                    `Failed to fetch dashboard data: ${response.statusText}`,
                  );
                const data = await response.json();
                return data.data;
              },
              staleTime: 2 * 60 * 1000,
            });
          }
          if (consulteeId) {
            queryClient.prefetchQuery({
              queryKey: ["consultee-events", consulteeId],
              queryFn: async () => {
                const response = await fetch(
                  `/api/dashboard/consultee/${consulteeId}/events`,
                );
                if (!response.ok)
                  throw new Error(
                    `Failed to fetch events: ${response.statusText}`,
                  );
                const data = await response.json();
                return data.data;
              },
              staleTime: 2 * 60 * 1000,
            });
          }
          break;
        case "planner":
          if (consultantId) {
            queryClient.prefetchQuery({
              queryKey: ["planner", consultantId],
              queryFn: async () => {
                const response = await fetch(
                  `/api/dashboard/consultant/${consultantId}/planner`,
                );
                if (!response.ok)
                  throw new Error(
                    `Failed to fetch planner: ${response.statusText}`,
                  );
                const data = await response.json();
                return data.data;
              },
              staleTime: 2 * 60 * 1000,
            });
          }
          break;
        case "requests":
          if (consultantId) {
            queryClient.prefetchQuery({
              queryKey: ["requests", consultantId],
              queryFn: async () => {
                const response = await fetch(
                  `/api/dashboard/consultant/${consultantId}/requests`,
                );
                if (!response.ok)
                  throw new Error(
                    `Failed to fetch requests: ${response.statusText}`,
                  );
                const data = await response.json();
                return data.data;
              },
              staleTime: 1 * 60 * 1000,
            });
          }
          break;
      }
    },
    [queryClient, consultantId, consulteeId],
  );

  // Auto-prefetch on hook initialization when aggressive prefetching is enabled
  useEffect(() => {
    if (!enableAggressivePrefetch) return;

    // Use requestIdleCallback for non-blocking prefetch, fallback to setTimeout
    const schedulePretech = (callback: () => void, delay = 0) => {
      if (typeof window !== "undefined" && "requestIdleCallback" in window) {
        const idleCallback = () => {
          if (delay > 0) {
            setTimeout(callback, delay);
          } else {
            callback();
          }
        };
        window.requestIdleCallback(idleCallback);
      } else {
        setTimeout(callback, delay + 100); // Fallback with small additional delay
      }
    };

    // Priority 1: Immediate critical data
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

  return {
    prefetchAllConsultantData,
    prefetchAllConsulteeData,
    prefetchOnTabHover,
    // Legacy compatibility
    prefetchConsultantDashboard: prefetchAllConsultantData,
    prefetchConsulteeEvents: prefetchAllConsulteeData,
  };
}
