/**
 * Service for managing consultation plans
 */

import type { ConsultationPlan } from "@/schemas/plans";
import { ConsultationPlanEvent } from "@/types/planner-events";

export class ConsultationService {
  /**
   * Check if a consultation plan title already exists for a consultant
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
        `/api/bookings/consultations/check-duplicate-title?${params}`,
      );
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error ||
            "Failed to check for duplicate consultation plan titles",
        );
      }

      const { isDuplicate } = await response.json();
      return isDuplicate;
    } catch (error) {
      console.error("[ConsultationService.checkDuplicateTitle] Error:", error);
      return false;
    }
  }

  /**
   * Fetch consultation plans for a consultant
   * API returns topics as string[] - no transformation needed
   */
  static async fetchConsultationPlans(
    consultantId: string,
  ): Promise<ConsultationPlanEvent[]> {
    try {
      const response = await fetch(
        `/api/plans/consultations?consultantId=${consultantId}`,
      );

      if (!response.ok) {
        throw new Error("Failed to fetch consultation plans");
      }

      const { data } = await response.json();

      // API returns topics as strings, just wrap with event type
      return data.map((plan: ConsultationPlan & { id: string }) => ({
        id: plan.id,
        type: "consultation" as const,
        consultationPlan: plan,
      }));
    } catch (error) {
      console.error(
        "[ConsultationService.fetchConsultationPlans] Error:",
        error,
      );
      throw error;
    }
  }

  /**
   * Save consultation plan data
   */
  static async saveConsultationPlan(
    planData: Partial<ConsultationPlanEvent>,
    consultantId: string,
  ): Promise<ConsultationPlanEvent> {
    try {
      if (!planData.consultationPlan) {
        throw new Error("Consultation plan data is required");
      }

      const isUpdate = !!planData.consultationPlan.id;
      const endpoint = isUpdate
        ? `/api/plans/consultations/${planData.consultationPlan.id}`
        : "/api/plans/consultations";
      const method = isUpdate ? "PUT" : "POST";

      // Build request body - keep null values to allow clearing fields
      const plan = planData.consultationPlan;
      const requestBody: Record<string, unknown> = {
        title: plan.title,
        description: plan.description,
        durationInHours: plan.durationInHours,
        // The form edits rupees; the DB stores paise (#780 money model).
        price: Math.round(plan.price * 100),
        priceCurrency: plan.priceCurrency,
        language: plan.language,
        level: plan.level,
        prerequisites: plan.prerequisites,
        materialProvided: plan.materialProvided,
        learningOutcomes: plan.learningOutcomes,
        topics: plan.topics ?? [],
        // ADR 24 positioning content. The endpoint has always validated and
        // persisted these (see the nested faqs create); the service simply never
        // sent them, so authoring through the planner produced a plan with no
        // subtitle, audience, inclusions or FAQ no matter what was typed.
        subtitle: plan.subtitle ?? null,
        targetAudience: plan.targetAudience ?? [],
        whatsIncluded: plan.whatsIncluded ?? [],
        faqs: plan.faqs ?? [],
        // #1134 P1-6 — recording is an explicit per-plan opt-in on all four
        // types now; the endpoints persist both columns.
        recordingEnabled: plan.recordingEnabled ?? false,
        recordingStoragePolicy: plan.recordingStoragePolicy ?? "STREAM_ONLY",
        consultantProfileId: consultantId,
        ...(isUpdate && plan.id ? { id: plan.id } : {}),
      };

      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error ||
            `Failed to ${isUpdate ? "update" : "create"} consultation plan`,
        );
      }

      const { data: consultationPlan } = await response.json();

      // API returns topics as strings, no transformation needed
      return {
        id: consultationPlan.id,
        type: "consultation" as const,
        consultationPlan,
      };
    } catch (error) {
      console.error("[ConsultationService.saveConsultationPlan] Error:", error);
      throw error;
    }
  }

  /**
   * Delete a consultation plan
   */
  static async deleteConsultationPlan(planId: string): Promise<boolean> {
    try {
      const response = await fetch(`/api/plans/consultations/${planId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to delete consultation plan",
        );
      }

      return true;
    } catch (error) {
      console.error(
        "[ConsultationService.deleteConsultationPlan] Error:",
        error,
      );
      throw error;
    }
  }
}
