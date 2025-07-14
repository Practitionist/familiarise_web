"use client";

import { useQuery } from "@tanstack/react-query";
import { faqs, type FAQ } from "../(features)/help/questions";

// Since help data is static, we'll use React Query for consistency
// but return the static data immediately
export function useHelp() {
  return useQuery({
    queryKey: ["help-faqs"],
    queryFn: (): FAQ[] => {
      // Return static FAQ data immediately
      return faqs;
    },
    staleTime: Infinity, // Static data never becomes stale
    gcTime: Infinity, // Keep in cache forever
    refetchOnWindowFocus: false,
    retry: false, // No need to retry static data
  });
}
