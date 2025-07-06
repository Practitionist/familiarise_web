"use client";

import { useQuery } from "@tanstack/react-query";
import { TAppointment } from "@/types/appointment";

interface RequestsData {
  consultations: any[];
  subscriptions: any[];
  weeklyAvailability: any[];
  customAvailability: any[];
  appointments: TAppointment[];
  consultant: any;
}

async function fetchRequestsData(consultantId: string): Promise<RequestsData> {
  const response = await fetch(`/api/dashboard/consultant/${consultantId}/requests`);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch requests data: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.data;
}

export function useRequests(consultantId: string) {
  return useQuery({
    queryKey: ['requests', consultantId],
    queryFn: () => fetchRequestsData(consultantId),
    staleTime: 1 * 60 * 1000, // 1 minute - requests change frequently
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    retry: 2,
  });
}