"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  PlannerWebinarEvent,
  PlannerClassEvent,
  ConsultationPlanEvent,
  SubscriptionPlanEvent,
} from "../(features)/planner/types/event";
import { ConsultationPlan, SubscriptionPlan } from "@/schemas/plans";

interface PlannerData {
  webinars: PlannerWebinarEvent[];
  classes: PlannerClassEvent[];
  consultationPlans: ConsultationPlanEvent[];
  subscriptionPlans: SubscriptionPlanEvent[];
  participantCounts: Record<string, number>;
}

// Types for mutation inputs
type ConsultationPlanInput =
  | (Partial<ConsultationPlan> & {
      consultantProfileId?: string;
    })
  | undefined;

type ConsultationPlanUpdateInput = {
  id: string;
  [key: string]: unknown;
};

type SubscriptionPlanInput =
  | (Partial<SubscriptionPlan> & {
      consultantProfileId?: string;
    })
  | undefined;

type SubscriptionPlanUpdateInput = {
  id: string;
  [key: string]: unknown;
};

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
      // FIX #622: Use the guarded route that checks for active payments
      // and upcoming slots before allowing deletion.
      const response = await fetch(
        `/api/events/webinars/${webinarId}`,
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
      // FIX #622: Use the guarded route that checks for active payments
      // and upcoming slots before allowing deletion.
      const response = await fetch(
        `/api/events/classes/${classId}`,
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

// Consultation plan hooks
export function useConsultationPlans(consultantId: string) {
  return useQuery({
    queryKey: ["consultationPlans", consultantId],
    queryFn: async () => {
      const response = await fetch(
        `/api/plans/consultations?consultantId=${consultantId}`,
      );
      if (!response.ok) {
        throw new Error("Failed to fetch consultation plans");
      }
      const data = await response.json();
      return data.data;
    },
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 2,
  });
}

export function useConsultationPlanMutations(consultantId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createConsultationPlan = useMutation({
    mutationFn: async (planData: ConsultationPlanInput) => {
      const response = await fetch("/api/plans/consultations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...planData,
          consultantProfileId: consultantId,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to create consultation plan",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["consultationPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["planner", consultantId] });
      toast({
        title: "Success",
        description: "Consultation plan created successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateConsultationPlan = useMutation({
    mutationFn: async ({ id, ...planData }: ConsultationPlanUpdateInput) => {
      const response = await fetch(`/api/plans/consultations/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(planData),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to update consultation plan",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["consultationPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["planner", consultantId] });
      toast({
        title: "Success",
        description: "Consultation plan updated successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteConsultationPlan = useMutation({
    mutationFn: async (planId: string) => {
      const response = await fetch(`/api/plans/consultations/${planId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to delete consultation plan",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["consultationPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["planner", consultantId] });
      toast({
        title: "Success",
        description: "Consultation plan deleted successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return {
    createConsultationPlan,
    updateConsultationPlan,
    deleteConsultationPlan,
  };
}

// Subscription plan hooks
export function useSubscriptionPlans(consultantId: string) {
  return useQuery({
    queryKey: ["subscriptionPlans", consultantId],
    queryFn: async () => {
      const response = await fetch(
        `/api/plans/subscriptions?consultantId=${consultantId}`,
      );
      if (!response.ok) {
        throw new Error("Failed to fetch subscription plans");
      }
      const data = await response.json();
      return data.data;
    },
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 2,
  });
}

export function useSubscriptionPlanMutations(consultantId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createSubscriptionPlan = useMutation({
    mutationFn: async (planData: SubscriptionPlanInput) => {
      const response = await fetch("/api/plans/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...planData,
          consultantProfileId: consultantId,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to create subscription plan",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["subscriptionPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["planner", consultantId] });
      toast({
        title: "Success",
        description: "Subscription plan created successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateSubscriptionPlan = useMutation({
    mutationFn: async ({ id, ...planData }: SubscriptionPlanUpdateInput) => {
      const response = await fetch(`/api/plans/subscriptions/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(planData),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to update subscription plan",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["subscriptionPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["planner", consultantId] });
      toast({
        title: "Success",
        description: "Subscription plan updated successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteSubscriptionPlan = useMutation({
    mutationFn: async (planId: string) => {
      const response = await fetch(`/api/plans/subscriptions/${planId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to delete subscription plan",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["subscriptionPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["planner", consultantId] });
      toast({
        title: "Success",
        description: "Subscription plan deleted successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return {
    createSubscriptionPlan,
    updateSubscriptionPlan,
    deleteSubscriptionPlan,
  };
}

// Hook for refetching planner data (useful after saves)
export function usePlannerRefresh(consultantId: string) {
  const queryClient = useQueryClient();

  const refreshPlanner = () => {
    queryClient.invalidateQueries({ queryKey: ["planner", consultantId] });
    queryClient.invalidateQueries({
      queryKey: ["consultationPlans", consultantId],
    });
    queryClient.invalidateQueries({
      queryKey: ["subscriptionPlans", consultantId],
    });
  };

  return { refreshPlanner };
}
