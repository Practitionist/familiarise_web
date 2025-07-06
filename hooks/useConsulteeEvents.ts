"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ConsultationWithPlan,
  SubscriptionWithPlan,
  WebinarWithPlan,
  ClassWithPlan,
} from "./useEvents";

interface ConsulteeEventsData {
  consultations: ConsultationWithPlan[];
  subscriptions: SubscriptionWithPlan[];
  webinars: WebinarWithPlan[];
  classes: ClassWithPlan[];
}

async function fetchConsulteeEventsData(consulteeProfileId: string): Promise<ConsulteeEventsData> {
  const response = await fetch(`/api/dashboard/consultee/${consulteeProfileId}`);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch events data: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.data;
}

export function useConsulteeEvents(consulteeProfileId: string) {
  return useQuery({
    queryKey: ['consultee-events', consulteeProfileId],
    queryFn: () => fetchConsulteeEventsData(consulteeProfileId),
    staleTime: 2 * 60 * 1000, // 2 minutes
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    retry: 2,
  });
}