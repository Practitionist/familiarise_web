"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

interface PrefetchDashboardOptions {
  consultantId?: string;
  consulteeId?: string;
}

export function usePrefetchDashboard({ consultantId, consulteeId }: PrefetchDashboardOptions = {}) {
  const queryClient = useQueryClient();

  const prefetchConsultantDashboard = useCallback(async () => {
    if (!consultantId) return;

    await queryClient.prefetchQuery({
      queryKey: ['consultant-dashboard', consultantId],
      queryFn: async () => {
        const response = await fetch(`/api/dashboard/consultant/${consultantId}`);
        if (!response.ok) {
          throw new Error(`Failed to fetch dashboard data: ${response.statusText}`);
        }
        const data = await response.json();
        return data.data;
      },
      staleTime: 2 * 60 * 1000, // 2 minutes
    });
  }, [queryClient, consultantId]);

  const prefetchConsulteeEvents = useCallback(async () => {
    if (!consulteeId) return;

    await queryClient.prefetchQuery({
      queryKey: ['consultee-events', consulteeId],
      queryFn: async () => {
        const response = await fetch(`/api/dashboard/consultee/${consulteeId}`);
        if (!response.ok) {
          throw new Error(`Failed to fetch events data: ${response.statusText}`);
        }
        const data = await response.json();
        return data.data;
      },
      staleTime: 2 * 60 * 1000, // 2 minutes
    });
  }, [queryClient, consulteeId]);

  const prefetchOnTabHover = useCallback((tabType: 'home' | 'appointments' | 'other') => {
    // Prefetch data based on tab type
    switch (tabType) {
      case 'home':
        if (consultantId) {
          prefetchConsultantDashboard();
        }
        if (consulteeId) {
          prefetchConsulteeEvents();
        }
        break;
      case 'appointments':
        // Could prefetch appointment-specific data here
        break;
      case 'other':
        // Could prefetch other tab-specific data here
        break;
    }
  }, [prefetchConsultantDashboard, prefetchConsulteeEvents, consultantId, consulteeId]);

  return {
    prefetchConsultantDashboard,
    prefetchConsulteeEvents,
    prefetchOnTabHover,
  };
}