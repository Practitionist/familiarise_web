/**
 * Service for managing webinars
 */

import { toast } from "@/hooks/use-toast";
import { TWebinar } from "@/types/appointment";
import { WebinarEvent } from "../../types/event";
import { TransactionContext } from "../transaction-context";
import { TopicService } from "../topic-service";
import { CreateWebinarPayload } from "../types";

export class WebinarService {
  /**
   * Check if a webinar title already exists for a consultant
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
        `/api/events/webinars/check-duplicate-title?${params}`,
      );
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to check for duplicate webinar titles",
        );
      }

      const { isDuplicate } = await response.json();
      return isDuplicate;
    } catch (error) {
      console.error(
        "[WebinarService.checkDuplicateTitle] Error:",
        error,
      );
      return false;
    }
  }

  /**
   * Fetch webinars for a consultant
   */
  static async fetchWebinars(
    consultantId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<WebinarEvent[]> {
    try {
      const params = new URLSearchParams({
        consultantProfileId: consultantId,
      });

      if (startDate && endDate) {
        params.append("startDate", startDate.toISOString());
        params.append("endDate", endDate.toISOString());
      }

      const response = await fetch(`/api/events/webinars?${params}`);
      if (!response.ok) {
        throw new Error("Failed to fetch webinars");
      }

      const { data } = await response.json();
      return data.map((webinar: TWebinar) =>
        this.transformWebinarResponse(webinar),
      );
    } catch (error) {
      console.error("[WebinarService.fetchWebinars] Error:", error);
      throw error;
    }
  }

  /**
   * Save webinar data with transaction handling
   */
  static async saveWebinar(
    webinarData: Partial<WebinarEvent>,
    scheduledAt: string | Date | null | undefined,
    consultantId: string,
  ): Promise<WebinarEvent> {
    const txContext = new TransactionContext();

    try {
      const title = webinarData.webinarPlan?.title;
      const planId = webinarData.webinarPlan?.id ?? "";
      const isUpdate = !!planId;
      const webinarId = webinarData.id ?? "";

      // Check for duplicate title
      if (title) {
        const isDuplicate = await this.checkDuplicateTitle(
          title,
          consultantId,
          planId,
        );
        if (isDuplicate) {
          throw new Error(
            `A webinar with title "${title}" already exists. Please use a different title.`,
          );
        }
      }

      // Extract and create topics
      let allTopicIds: string[] = [];
      const topicNames = this.extractTopicNames(webinarData);

      if (topicNames.length > 0) {
        try {
          const newTopicIds = await TopicService.createTopics(topicNames);
          txContext.trackTopics(newTopicIds);
          allTopicIds = [...newTopicIds];
        } catch (error) {
          throw new Error(
            "Failed to create topics: " +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }

      try {
        const endpoint = "/api/events/webinars/crud-with-plan";
        const method = isUpdate ? "PATCH" : "POST";

        const scheduledAtDate = this.parseScheduledDate(scheduledAt);
        const requestBody = this.buildRequestBody(
          webinarData,
          consultantId,
          allTopicIds,
          topicNames,
          scheduledAtDate,
          isUpdate,
          planId,
          webinarId,
        );

        const response = await fetch(endpoint, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(
            errorData.error ||
              `Failed to ${isUpdate ? "update" : "create"} webinar`,
          );
        }

        const { data: webinar } = await response.json();

        if (!isUpdate) {
          txContext.trackEvent(webinar.id, "webinar");
        }

        txContext.clear();
        return { ...webinar, type: "webinar" as const };
      } catch (error) {
        await txContext.rollbackTopics();
        throw error;
      }
    } catch (error) {
      console.error("[WebinarService.saveWebinar] Error:", error);
      throw error;
    }
  }

  /**
   * Delete a webinar
   */
  static async deleteWebinar(webinarId: string): Promise<boolean> {
    try {
      const response = await fetch(`/api/events/webinars/${webinarId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to delete webinar");
      }

      return true;
    } catch (error) {
      console.error("[WebinarService.deleteWebinar] Error:", error);
      throw error;
    }
  }

  // Private helper methods

  /**
   * Transform API response to WebinarEvent with computed scheduledAt
   */
  private static transformWebinarResponse(webinar: TWebinar): WebinarEvent {
    // Compute scheduledAt from appointment slots
    const startsAt = webinar.appointment?.slotsOfAppointment?.[0]?.startsAt;
    const scheduledAt = startsAt ? new Date(startsAt) : undefined;

    // Spread Prisma response and add discriminant + computed property
    return {
      ...webinar,
      type: "webinar" as const,
      scheduledAt,
    };
  }

  private static extractTopicNames(
    webinarData: Partial<WebinarEvent>,
  ): string[] {
    if (!webinarData.webinarPlan?.topics) {
      return [];
    }

    return webinarData.webinarPlan.topics
      .map((topic) => (typeof topic === "string" ? topic : topic?.name))
      .filter(Boolean) as string[];
  }

  private static parseScheduledDate(
    scheduledAt: string | Date | null | undefined,
  ): Date | null {
    if (!scheduledAt) return null;

    if (typeof scheduledAt === "string") {
      return new Date(scheduledAt);
    } else if (scheduledAt instanceof Date) {
      return scheduledAt;
    }
    return null;
  }

  private static buildRequestBody(
    webinarData: Partial<WebinarEvent>,
    consultantId: string,
    allTopicIds: string[],
    topicNames: string[],
    scheduledAtDate: Date | null,
    isUpdate: boolean,
    planId: string,
    webinarId: string,
  ): CreateWebinarPayload & { id?: string; webinarId?: string; topics?: string[] } {
    const plan = webinarData.webinarPlan;

    if (isUpdate) {
      const body: Record<string, unknown> = {
        id: planId,
        webinarId: webinarId || undefined,
        title: plan?.title,
        description: plan?.description,
        price: plan?.price,
        priceCurrency: plan?.priceCurrency,
        certificateProvided: plan?.certificateProvided,
        durationInHours:
          typeof plan?.durationInHours === "number"
            ? plan.durationInHours
            : undefined,
        maxParticipants: plan?.maxParticipants,
        language: plan?.language,
        level: plan?.level,
        prerequisites: plan?.prerequisites,
        materialProvided: plan?.materialProvided,
        learningOutcomes: plan?.learningOutcomes,
        consultantProfileId: consultantId,
        scheduledAt: scheduledAtDate,
        topics:
          allTopicIds.length > 0
            ? allTopicIds
            : topicNames.length === 0
              ? []
              : undefined,
      };

      // Remove undefined fields
      Object.keys(body).forEach(
        (key) => body[key] === undefined && delete body[key],
      );
      return body as unknown as CreateWebinarPayload & { id?: string; webinarId?: string; topics?: string[] };
    }

    // POST request
    const postPlanData = { ...plan };
    delete (postPlanData as Record<string, unknown>).topics;

    const body: Record<string, unknown> = {
      ...postPlanData,
      consultantProfileId: consultantId,
      scheduledAt: scheduledAtDate,
      topics: allTopicIds,
    };

    Object.keys(body).forEach(
      (key) => body[key] === undefined && delete body[key],
    );
    return body as unknown as CreateWebinarPayload & { topics?: string[] };
  }

  /**
   * Show success toast for webinar operations
   */
  static showSuccessToast(title: string, isUpdate: boolean): void {
    const action = isUpdate ? "Updated" : "Created";
    toast({
      title: "Success",
      description: `${action} webinar "${title}" successfully`,
    });
  }
}
