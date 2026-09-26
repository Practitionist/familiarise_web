"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useChatUnreadCount } from "@/hooks/useChatUnreadCount";

interface InboxCountsResponse {
  counts?: Record<string, number>;
}

async function fetchRequestsCount(
  consultantProfileId: string,
): Promise<number> {
  const params = new URLSearchParams({ consultantProfileId, countsOnly: "1" });
  const res = await fetch(`/api/bookings/inbox?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to load request counts");
  const body = (await res.json()) as InboxCountsResponse;
  return Object.values(body.counts ?? {}).reduce((sum, n) => sum + n, 0);
}

/**
 * Nav badge counts for the personal shells (#1527), keyed by `NavItem.badgeKey`.
 * Messages: the personal-inbox unread count (both shells). Requests: the
 * consultant inbox's own tab counts, under the inbox's query-key prefix so
 * the inbox's invalidations refresh the badge too.
 */
export function usePersonalNavBadges(options: {
  requestsForConsultantId?: string;
}): Record<string, number | undefined> {
  const messages = useChatUnreadCount();
  const consultantId = options.requestsForConsultantId;
  const { data: requests } = useQuery({
    queryKey: ["requests-inbox", consultantId, "nav-count"],
    queryFn: () => fetchRequestsCount(consultantId!),
    enabled: !!consultantId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return useMemo(() => ({ messages, requests }), [messages, requests]);
}
