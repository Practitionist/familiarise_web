"use client";

import { useQuery } from "@tanstack/react-query";

interface ConsulteeEventsData {
  consultations: any[];
  subscriptions: any[];
  webinars: any[];
  classes: any[];
}

async function fetchConsulteeEvents(
  consulteeId: string,
): Promise<ConsulteeEventsData> {
  const response = await fetch(
    `/api/dashboard/consultee/${consulteeId}/events`,
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch consultee events: ${response.statusText}`);
  }

  const data = await response.json();
  return data.data;
}

export function useConsulteeEvents(consulteeId: string) {
  return useQuery({
    queryKey: ["consultee-events", consulteeId],
    queryFn: () => fetchConsulteeEvents(consulteeId),
    staleTime: 2 * 60 * 1000, // 2 minutes - events change frequently
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    retry: 2,
  });
}
