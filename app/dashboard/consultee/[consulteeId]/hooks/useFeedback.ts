"use client";

import { useQuery } from "@tanstack/react-query";

async function fetchFeedbackData() {
  const response = await fetch(`/api/user/feedbacks`);

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to fetch feedback history");
  }

  return response.json();
}

async function fetchSupportTickets() {
  const response = await fetch(`/api/user/support-tickets`);

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to fetch support tickets");
  }

  return response.json();
}

export function useFeedback() {
  return useQuery({
    queryKey: ["feedback"],
    queryFn: fetchFeedbackData,
    staleTime: 2 * 60 * 1000, // 2 minutes
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    retry: 2,
  });
}

export function useSupportTickets() {
  return useQuery({
    queryKey: ["support-tickets"],
    queryFn: fetchSupportTickets,
    staleTime: 2 * 60 * 1000, // 2 minutes
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    retry: 2,
  });
}
