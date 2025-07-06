"use client";

import { useQuery } from "@tanstack/react-query";
import { IAppointment } from "../types";
import { fetchAppointments } from "../utils/fetchHelpers";

export function useAppointments(consultantId: string) {
  return useQuery({
    queryKey: ['appointments', consultantId],
    queryFn: () => fetchAppointments(consultantId),
    staleTime: 2 * 60 * 1000, // 2 minutes
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    retry: 2,
  });
}