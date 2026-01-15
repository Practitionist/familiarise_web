/**
 * Service for managing subscription plans
 */

import type { SubscriptionPlan } from "@/schemas/plans";
import { SubscriptionPlanEvent } from "../../types/event";

export class SubscriptionService {
  /**
   * Check if a subscription plan title already exists for a consultant
   */
  static async checkDuplicateTitle(
    title: string,
    consultantId: string,
    excludeId: string = "",
  ): Promise<boolean> {
    try {
      const params = new URLSearchParams({
        title,
        consultantProfileId: consultantId,
      });
      if (excludeId) {
        params.append("excludeId", excludeId);
      }

      const response = await fetch(
        `/api/events/subscriptions/check-duplicate-title?${params}`,
      );
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error ||
            "Failed to check for duplicate subscription plan titles",
        );
      }

      const { isDuplicate } = await response.json();
      return isDuplicate;
    } catch (error) {
      console.error(
        "[SubscriptionService.checkDuplicateTitle] Error:",
        error,
      );
      return false;
    }
  }

  /**
   * Fetch subscription plans for a consultant
   */
  static async fetchSubscriptionPlans(
    consultantId: string,
  ): Promise<SubscriptionPlanEvent[]> {
    try {
      const response = await fetch(
        `/api/plans/subscriptions?consultantId=${consultantId}`,
      );

      if (!response.ok) {
        throw new Error("Failed to fetch subscription plans");
      }

      const { data } = await response.json();
      return data.map((plan: SubscriptionPlan & { id: string }) => ({
        id: plan.id,
        type: "subscription" as const,
        subscriptionPlan: plan,
      }));
    } catch (error) {
      console.error(
        "[SubscriptionService.fetchSubscriptionPlans] Error:",
        error,
      );
      throw error;
    }
  }

  /**
   * Save subscription plan data
   */
  static async saveSubscriptionPlan(
    planData: Partial<SubscriptionPlanEvent>,
    consultantId: string,
  ): Promise<SubscriptionPlanEvent> {
    try {
      if (!planData.subscriptionPlan) {
        throw new Error("Subscription plan data is required");
      }

      const isUpdate = !!planData.subscriptionPlan.id;
      const endpoint = isUpdate
        ? `/api/plans/subscriptions/${planData.subscriptionPlan.id}`
        : "/api/plans/subscriptions";
      const method = isUpdate ? "PUT" : "POST";

      // Build request body, handling null to undefined conversions for API compatibility
      const plan = planData.subscriptionPlan;
      const requestBody: Record<string, unknown> = {
        title: plan.title,
        description: plan.description ?? undefined,
        durationInMonths: plan.durationInMonths,
        sessionDurationInHours: plan.sessionDurationInHours,
        callsPerWeek: plan.callsPerWeek,
        price: plan.price,
        priceCurrency: plan.priceCurrency,
        emailSupport: plan.emailSupport,
        language: plan.language ?? undefined,
        level: plan.level ?? undefined,
        prerequisites: plan.prerequisites ?? undefined,
        materialProvided: plan.materialProvided ?? undefined,
        learningOutcomes: plan.learningOutcomes,
        consultantProfileId: consultantId,
        ...(isUpdate && plan.id ? { id: plan.id } : {}),
      };

      // Remove undefined fields
      Object.keys(requestBody).forEach((key) => {
        if (requestBody[key] === undefined) {
          delete requestBody[key];
        }
      });

      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error ||
            `Failed to ${isUpdate ? "update" : "create"} subscription plan`,
        );
      }

      const { data: subscriptionPlan } = await response.json();

      return {
        id: subscriptionPlan.id,
        type: "subscription" as const,
        subscriptionPlan,
      };
    } catch (error) {
      console.error(
        "[SubscriptionService.saveSubscriptionPlan] Error:",
        error,
      );
      throw error;
    }
  }

  /**
   * Delete a subscription plan
   */
  static async deleteSubscriptionPlan(planId: string): Promise<boolean> {
    try {
      const response = await fetch(`/api/plans/subscriptions/${planId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to delete subscription plan",
        );
      }

      return true;
    } catch (error) {
      console.error(
        "[SubscriptionService.deleteSubscriptionPlan] Error:",
        error,
      );
      throw error;
    }
  }
}
