"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

interface PlannerData {
  webinars: any[];
  classes: any[];
  participantCounts: Record<string, number>;
}

// Main planner data hook
async function fetchPlannerData(consultantId: string): Promise<PlannerData> {
  const response = await fetch(
    `/api/dashboard/consultant/${consultantId}/planner`,
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch planner data: ${response.statusText}`);
  }

  const data = await response.json();
  return data.data;
}

export function usePlanner(consultantId: string) {
  return useQuery({
    queryKey: ["planner", consultantId],
    queryFn: () => fetchPlannerData(consultantId),
    staleTime: 2 * 60 * 1000, // 2 minutes - events change frequently
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    retry: 2,
  });
}

// Webinar mutation hooks
export function useWebinarMutations(consultantId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const deleteWebinar = useMutation({
    mutationFn: async (webinarId: string) => {
      const response = await fetch(
        `/api/events/webinars/crud-with-plan/${webinarId}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to delete webinar");
      }

      return response.json();
    },
    onSuccess: (result) => {
      // Invalidate and refetch planner data
      queryClient.invalidateQueries({ queryKey: ["planner", consultantId] });
      toast({
        title: "Success",
        description: result.message || "Webinar deleted successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to delete webinar.",
        variant: "destructive",
      });
    },
  });

  return { deleteWebinar };
}

// Class mutation hooks
export function useClassMutations(consultantId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const deleteClass = useMutation({
    mutationFn: async (classId: string) => {
      const response = await fetch(
        `/api/events/classes/crud-with-plan/${classId}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to delete class");
      }

      return response.json();
    },
    onSuccess: (result) => {
      // Invalidate and refetch planner data
      queryClient.invalidateQueries({ queryKey: ["planner", consultantId] });
      toast({
        title: "Success",
        description: result.message || "Class deleted successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to delete class.",
        variant: "destructive",
      });
    },
  });

  return { deleteClass };
}

// Hook for refetching planner data (useful after saves)
export function usePlannerRefresh(consultantId: string) {
  const queryClient = useQueryClient();

  const refreshPlanner = () => {
    queryClient.invalidateQueries({ queryKey: ["planner", consultantId] });
  };

  return { refreshPlanner };
}
