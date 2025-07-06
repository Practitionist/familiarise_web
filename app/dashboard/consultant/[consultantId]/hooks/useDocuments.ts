"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchDocuments } from "../utils/fetchHelpers";

export function useDocuments(consultantId: string) {
  return useQuery({
    queryKey: ['documents', consultantId],
    queryFn: () => fetchDocuments(consultantId),
    staleTime: 2 * 60 * 1000, // 2 minutes - documents don't change frequently
    gcTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
    retry: 2,
  });
}