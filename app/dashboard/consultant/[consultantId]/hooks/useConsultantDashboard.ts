"use client";

import { useQuery } from "@tanstack/react-query";
import { TAppointment } from "@/types/appointment";
import { IActivity, IApproval, ApiResponse } from "../types";

interface ConsultantDashboardData {
  appointments: TAppointment[];
  activities: IActivity[];
  approvals: IApproval[];
}

async function fetchConsultantDashboardData(
  consultantId: string,
): Promise<ConsultantDashboardData> {
  const response = await fetch(`/api/dashboard/consultant/${consultantId}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch dashboard data: ${response.statusText}`);
  }

  const data: ApiResponse<ConsultantDashboardData> = await response.json();
  return data.data;
}

export function useConsultantDashboard(consultantId: string) {
  return useQuery({
    queryKey: ["consultant-dashboard", consultantId],
    queryFn: () => fetchConsultantDashboardData(consultantId),
    staleTime: 2 * 60 * 1000, // 2 minutes
    gcTime: 5 * 60 * 1000, // 5 minutes (renamed from cacheTime in v5)
    refetchOnWindowFocus: false,
    retry: 2,
  });
}
