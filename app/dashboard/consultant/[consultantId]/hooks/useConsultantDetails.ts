"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchConsultantDetails } from "@/lib/user";

export function useConsultantDetails(consultantId: string) {
  return useQuery({
    queryKey: ["consultant-details", consultantId],
    queryFn: () => fetchConsultantDetails(consultantId),
    staleTime: 5 * 60 * 1000, // 5 minutes - user details don't change often
    gcTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
    retry: 2,
  });
}
