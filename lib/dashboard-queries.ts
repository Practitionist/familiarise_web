/**
 * Centralized Dashboard Query Factory
 *
 * This module provides optimized query configurations for all dashboard types.
 * Key optimizations:
 * 1. Parallel data fetching with Promise.all
 * 2. Stale-while-revalidate for instant perceived loading
 * 3. Intelligent cache management with gcTime
 * 4. Query dependencies for sequential fetching when needed
 * 5. Prefetch strategies for predictive loading
 */

import type { TConsultantDashboardResponse } from "@/types/consultant-events";
import type { TAppointment } from "@/types/appointment";
import type { TConsultantProfile } from "@/types/consultant";
import type { TConsulteeEventsResponse } from "@/types/consultee-events";
import type {
  TConsulteeProfile,
  TConsulteeProfileWithBackground,
} from "@/types/consultee";
import type {
  PlannerWebinarEvent,
  PlannerClassEvent,
} from "@/app/dashboard/consultant/[consultantId]/(features)/planner/types/event";

// =============================================================================
// Types
// =============================================================================

interface PlannerData {
  webinars: PlannerWebinarEvent[];
  classes: PlannerClassEvent[];
  participantCounts: Record<string, number>;
}

export interface QueryConfig {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  staleTime: number;
  gcTime: number;
  retry?: number | boolean;
  refetchOnWindowFocus?: boolean;
  enabled?: boolean;
}

export interface DashboardQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
  isStale: boolean;
  refetch: () => void;
}

// =============================================================================
// Fetch Functions
// =============================================================================

async function fetchWithErrorHandling<T>(
  url: string,
  errorPrefix: string,
): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${errorPrefix}: ${response.statusText}`);
  }
  const json = await response.json();
  return json.data ?? json;
}

// Consultant fetchers
export const consultantFetchers = {
  dashboard: (consultantId: string) =>
    fetchWithErrorHandling<TConsultantDashboardResponse>(
      `/api/dashboard/consultant/${consultantId}`,
      "Dashboard fetch failed",
    ),

  appointments: (consultantId: string) =>
    fetchWithErrorHandling<TAppointment[]>(
      `/api/slots/appointments?consultantProfileId=${consultantId}`,
      "Appointments fetch failed",
    ),

  details: (consultantId: string) =>
    fetchWithErrorHandling<TConsultantProfile>(
      `/api/user/consultants/${consultantId}`,
      "Consultant details fetch failed",
    ),

  requests: (consultantId: string) =>
    fetchWithErrorHandling<TAppointment[]>(
      `/api/dashboard/consultant/${consultantId}/requests`,
      "Requests fetch failed",
    ),

  planner: (consultantId: string) =>
    fetchWithErrorHandling<PlannerData>(
      `/api/dashboard/consultant/${consultantId}/planner`,
      "Planner fetch failed",
    ),

  documents: (consultantId: string) =>
    fetchWithErrorHandling<TAppointment[]>(
      `/api/dashboard/consultant/${consultantId}/documents`,
      "Documents fetch failed",
    ),
};

// Consultee fetchers
export const consulteeFetchers = {
  events: (consulteeId: string) =>
    fetchWithErrorHandling<TConsulteeEventsResponse>(
      `/api/dashboard/consultee/${consulteeId}/events`,
      "Events fetch failed",
    ),

  profile: (consulteeId: string) =>
    fetchWithErrorHandling<TConsulteeProfile>(
      `/api/user/consultees/${consulteeId}`,
      "Profile fetch failed",
    ),

  /** Same endpoint as profile but typed with education + workExperiences includes. */
  profileWithBackground: (consulteeId: string) =>
    fetchWithErrorHandling<TConsulteeProfileWithBackground>(
      `/api/user/consultees/${consulteeId}`,
      "Profile fetch failed",
    ),

  feedback: () =>
    fetchWithErrorHandling<Record<string, unknown>[]>(
      `/api/user/feedbacks`,
      "Feedback fetch failed",
    ),

  supportTickets: () =>
    fetchWithErrorHandling<Record<string, unknown>[]>(
      `/api/user/support-tickets`,
      "Support tickets fetch failed",
    ),

  messages: (consulteeId: string) =>
    fetchWithErrorHandling<Record<string, unknown>[]>(
      `/api/dashboard/consultee/${consulteeId}/messages`,
      "Messages fetch failed",
    ).catch((): Record<string, unknown>[] => []),
};

// Admin fetchers
export const adminFetchers = {
  stats: () =>
    fetchWithErrorHandling(`/api/admin/stats`, "Admin stats fetch failed"),

  users: () => fetchWithErrorHandling(`/api/admin/users`, "Users fetch failed"),

  payments: (page = 1, limit = 20) =>
    fetchWithErrorHandling(
      `/api/admin/payments?page=${page}&limit=${limit}`,
      "Payments fetch failed",
    ),

  analytics: () =>
    fetchWithErrorHandling(`/api/admin/analytics`, "Analytics fetch failed"),

  disputes: () =>
    fetchWithErrorHandling(`/api/admin/disputes`, "Disputes fetch failed"),

  refunds: () =>
    fetchWithErrorHandling(`/api/admin/refunds`, "Refunds fetch failed"),
};

// User fetchers (shared)
export const userFetchers = {
  details: (userId: string) =>
    fetchWithErrorHandling(`/api/user/${userId}`, "User details fetch failed"),
};

// =============================================================================
// Query Factories
// =============================================================================

// Stale time constants (in ms)
const STALE_TIMES = {
  INSTANT: 0, // Always refetch
  SHORT: 30 * 1000, // 30 seconds
  MEDIUM: 2 * 60 * 1000, // 2 minutes
  LONG: 5 * 60 * 1000, // 5 minutes
  STATIC: Infinity, // Never refetch
};

// Garbage collection time (how long to keep unused data)
const GC_TIME = 10 * 60 * 1000; // 10 minutes

/**
 * Consultant Dashboard Queries
 */
export function createConsultantQueries(consultantId: string) {
  return {
    // Primary data for home dashboard
    dashboard: {
      queryKey: ["consultant-dashboard", consultantId] as const,
      queryFn: () => consultantFetchers.dashboard(consultantId),
      staleTime: STALE_TIMES.MEDIUM,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Appointments with all statuses
    appointments: {
      queryKey: ["consultant-appointments", consultantId] as const,
      queryFn: () => consultantFetchers.appointments(consultantId),
      staleTime: STALE_TIMES.SHORT,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Consultant profile details
    details: {
      queryKey: ["consultant-details", consultantId] as const,
      queryFn: () => consultantFetchers.details(consultantId),
      staleTime: STALE_TIMES.LONG,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Pending requests
    requests: {
      queryKey: ["consultant-requests", consultantId] as const,
      queryFn: () => consultantFetchers.requests(consultantId),
      staleTime: STALE_TIMES.SHORT,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Planner/calendar data
    planner: {
      queryKey: ["consultant-planner", consultantId] as const,
      queryFn: () => consultantFetchers.planner(consultantId),
      staleTime: STALE_TIMES.MEDIUM,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Documents for review
    documents: {
      queryKey: ["consultant-documents", consultantId] as const,
      queryFn: () => consultantFetchers.documents(consultantId),
      staleTime: STALE_TIMES.MEDIUM,
      gcTime: GC_TIME,
      retry: 2,
    },
  };
}

/**
 * Consultee Dashboard Queries
 */
export function createConsulteeQueries(consulteeId: string) {
  return {
    // All events (appointments, subscriptions, classes, webinars)
    events: {
      queryKey: ["consultee-events", consulteeId] as const,
      queryFn: () => consulteeFetchers.events(consulteeId),
      staleTime: STALE_TIMES.MEDIUM,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Consultee profile
    profile: {
      queryKey: ["consultee-profile", consulteeId] as const,
      queryFn: () => consulteeFetchers.profile(consulteeId),
      staleTime: STALE_TIMES.LONG,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Feedback data
    feedback: {
      queryKey: ["consultee-feedback"] as const,
      queryFn: () => consulteeFetchers.feedback(),
      staleTime: STALE_TIMES.MEDIUM,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Support tickets
    supportTickets: {
      queryKey: ["consultee-support-tickets"] as const,
      queryFn: () => consulteeFetchers.supportTickets(),
      staleTime: STALE_TIMES.MEDIUM,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Messages
    messages: {
      queryKey: ["consultee-messages", consulteeId] as const,
      queryFn: () => consulteeFetchers.messages(consulteeId),
      staleTime: STALE_TIMES.SHORT,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Settings (uses same endpoint as profile, typed with education/work includes)
    settings: {
      queryKey: ["consultee-settings", consulteeId] as const,
      queryFn: () => consulteeFetchers.profileWithBackground(consulteeId),
      staleTime: STALE_TIMES.LONG,
      gcTime: GC_TIME,
      retry: 2,
    },
  };
}

/**
 * Admin Dashboard Queries
 */
export function createAdminQueries() {
  return {
    // Overview stats
    stats: {
      queryKey: ["admin-stats"] as const,
      queryFn: () => adminFetchers.stats(),
      staleTime: STALE_TIMES.SHORT,
      gcTime: GC_TIME,
      retry: 2,
      refetchInterval: 2 * 60 * 1000, // Auto-refresh every 2 minutes
    },

    // User management
    users: {
      queryKey: ["admin-users"] as const,
      queryFn: () => adminFetchers.users(),
      staleTime: STALE_TIMES.MEDIUM,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Analytics data
    analytics: {
      queryKey: ["admin-analytics"] as const,
      queryFn: () => adminFetchers.analytics(),
      staleTime: STALE_TIMES.MEDIUM,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Disputes
    disputes: {
      queryKey: ["admin-disputes"] as const,
      queryFn: () => adminFetchers.disputes(),
      staleTime: STALE_TIMES.SHORT,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Refunds
    refunds: {
      queryKey: ["admin-refunds"] as const,
      queryFn: () => adminFetchers.refunds(),
      staleTime: STALE_TIMES.SHORT,
      gcTime: GC_TIME,
      retry: 2,
    },
  };
}

/**
 * User Queries (shared across all dashboards)
 */
export function createUserQueries(userId: string) {
  return {
    details: {
      queryKey: ["user-details", userId] as const,
      queryFn: () => userFetchers.details(userId),
      staleTime: STALE_TIMES.LONG,
      gcTime: GC_TIME,
      retry: 2,
    },
  };
}

// =============================================================================
// Prefetch Utilities
// =============================================================================

/**
 * Priority levels for prefetching
 */
export type PrefetchPriority = "high" | "medium" | "low";

/**
 * Get delay based on priority
 */
export function getPrefetchDelay(priority: PrefetchPriority): number {
  switch (priority) {
    case "high":
      return 0;
    case "medium":
      return 500;
    case "low":
      return 1000;
  }
}

/**
 * Batch prefetch with priority scheduling
 */
export async function batchPrefetch(
  queryClient: { prefetchQuery: (query: QueryConfig) => Promise<unknown> },
  queries: QueryConfig[],
  priority: PrefetchPriority = "medium",
): Promise<void> {
  const delay = getPrefetchDelay(priority);

  const execute = async () => {
    await Promise.allSettled(
      queries.map((query) => queryClient.prefetchQuery(query)),
    );
  };

  if (delay > 0) {
    setTimeout(execute, delay);
  } else {
    await execute();
  }
}

/**
 * Schedule prefetch using requestIdleCallback when available
 */
export function schedulePrefetch(callback: () => void, timeout = 2000): void {
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    window.requestIdleCallback(callback, { timeout });
  } else {
    setTimeout(callback, 100);
  }
}

// =============================================================================
// Query Keys for Invalidation
// =============================================================================

export const queryKeys = {
  consultant: {
    all: (consultantId: string) => ["consultant", consultantId] as const,
    dashboard: (consultantId: string) =>
      ["consultant-dashboard", consultantId] as const,
    appointments: (consultantId: string) =>
      ["consultant-appointments", consultantId] as const,
    details: (consultantId: string) =>
      ["consultant-details", consultantId] as const,
    requests: (consultantId: string) =>
      ["consultant-requests", consultantId] as const,
    planner: (consultantId: string) =>
      ["consultant-planner", consultantId] as const,
    documents: (consultantId: string) =>
      ["consultant-documents", consultantId] as const,
  },
  consultee: {
    all: (consulteeId: string) => ["consultee", consulteeId] as const,
    events: (consulteeId: string) => ["consultee-events", consulteeId] as const,
    profile: (consulteeId: string) =>
      ["consultee-profile", consulteeId] as const,
    feedback: () => ["consultee-feedback"] as const,
    supportTickets: () => ["consultee-support-tickets"] as const,
    messages: (consulteeId: string) =>
      ["consultee-messages", consulteeId] as const,
  },
  admin: {
    all: () => ["admin"] as const,
    stats: () => ["admin-stats"] as const,
    users: () => ["admin-users"] as const,
    analytics: () => ["admin-analytics"] as const,
    disputes: () => ["admin-disputes"] as const,
    refunds: () => ["admin-refunds"] as const,
  },
  user: {
    details: (userId: string) => ["user-details", userId] as const,
  },
};
