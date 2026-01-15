/**
 * Service for managing classes
 */

import { toast } from "@/hooks/use-toast";
import { TClass } from "@/types/appointment";
import { ClassEvent } from "../../types/event";
import { TransactionContext } from "../transaction-context";
import { TopicService } from "../topic-service";
import { CreateClassPayload, ClassContentInput } from "../types";

export class ClassService {
  /**
   * Check if a class title already exists for a consultant
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
        `/api/events/classes/check-duplicate-title?${params}`,
      );
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to check for duplicate class titles",
        );
      }

      const { isDuplicate } = await response.json();
      return isDuplicate;
    } catch (error) {
      console.error("[ClassService.checkDuplicateTitle] Error:", error);
      return false;
    }
  }

  /**
   * Fetch classes for a consultant
   */
  static async fetchClasses(
    consultantId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<ClassEvent[]> {
    try {
      const params = new URLSearchParams({
        consultantProfileId: consultantId,
      });

      if (startDate && endDate) {
        params.append("startDate", startDate.toISOString());
        params.append("endDate", endDate.toISOString());
      }

      const response = await fetch(`/api/events/classes?${params}`);
      if (!response.ok) {
        throw new Error("Failed to fetch classes");
      }

      const { data } = await response.json();
      return data.map((classEvent: TClass) =>
        this.transformClassResponse(classEvent),
      );
    } catch (error) {
      console.error("[ClassService.fetchClasses] Error:", error);
      throw error;
    }
  }

  /**
   * Save class data with transaction handling
   */
  static async saveClass(
    classData: Partial<ClassEvent>,
    consultantId: string,
  ): Promise<ClassEvent> {
    const txContext = new TransactionContext();

    try {
      const title = classData.classPlan?.title;
      const planId = classData.classPlan?.id ?? "";
      const isUpdate = !!planId;
      const classId = classData.id ?? "";

      // Check for duplicate title
      if (title) {
        const isDuplicate = await this.checkDuplicateTitle(
          title,
          consultantId,
          planId,
        );
        if (isDuplicate) {
          throw new Error(
            `A class with title "${title}" already exists. Please use a different title.`,
          );
        }
      }

      // Extract and create topics
      let allTopicIds: string[] = [];
      const topicNames = this.extractTopicNames(classData);

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
        const endpoint = "/api/events/classes/crud-with-plan";
        const method = isUpdate ? "PATCH" : "POST";

        const requestBody = this.buildRequestBody(
          classData,
          consultantId,
          allTopicIds,
          topicNames,
          isUpdate,
          planId,
          classId,
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
              `Failed to ${isUpdate ? "update" : "create"} class`,
          );
        }

        const { data: classEvent } = await response.json();

        if (!isUpdate) {
          txContext.trackEvent(classEvent.id, "class");
        }

        txContext.clear();
        return { ...classEvent, type: "class" as const };
      } catch (error) {
        await txContext.rollbackTopics();
        throw error;
      }
    } catch (error) {
      console.error("[ClassService.saveClass] Error:", error);
      throw error;
    }
  }

  /**
   * Delete a class
   */
  static async deleteClass(classId: string): Promise<boolean> {
    try {
      const response = await fetch(`/api/events/classes/${classId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to delete class");
      }

      return true;
    } catch (error) {
      console.error("[ClassService.deleteClass] Error:", error);
      throw error;
    }
  }

  // Private helper methods

  /**
   * Transform API response to ClassEvent with type discriminant
   */
  private static transformClassResponse(classEvent: TClass): ClassEvent {
    // Spread Prisma response and add discriminant
    return {
      ...classEvent,
      type: "class" as const,
    };
  }

  private static extractTopicNames(classData: Partial<ClassEvent>): string[] {
    if (!classData.classPlan?.topics) {
      return [];
    }

    return classData.classPlan.topics
      .map((topic) => (typeof topic === "string" ? topic : topic?.name))
      .filter(Boolean) as string[];
  }

  private static buildRequestBody(
    classData: Partial<ClassEvent>,
    consultantId: string,
    allTopicIds: string[],
    topicNames: string[],
    isUpdate: boolean,
    planId: string,
    classId: string,
  ): CreateClassPayload & { id?: string; classId?: string; topics?: string[] } {
    const plan = classData.classPlan;

    if (!plan && isUpdate) {
      throw new Error("Internal error: Class plan data is missing during update.");
    }

    if (isUpdate && plan) {
      const body: Record<string, unknown> = {
        id: planId,
        classId: classId || undefined,
        title: plan.title,
        description: plan.description,
        price: plan.price,
        priceCurrency: plan.priceCurrency,
        certificateProvided: plan.certificateProvided,
        durationInMonths:
          typeof plan.durationInMonths === "number"
            ? plan.durationInMonths
            : undefined,
        maxParticipants: plan.maxParticipants,
        language: plan.language,
        level: plan.level,
        prerequisites: plan.prerequisites,
        materialProvided: plan.materialProvided,
        learningOutcomes: plan.learningOutcomes,
        emailSupport: plan.emailSupport,
        meetingsPerWeek: plan.meetingsPerWeek,
        classContents: plan.classContents,
        consultantProfileId: consultantId,
        topics:
          allTopicIds.length > 0
            ? allTopicIds
            : topicNames.length === 0
              ? []
              : undefined,
      };

      Object.keys(body).forEach(
        (key) => body[key] === undefined && delete body[key],
      );
      return body as unknown as CreateClassPayload & { id?: string; classId?: string; topics?: string[] };
    }

    // POST request
    const postPlanData = { ...plan };
    delete (postPlanData as Record<string, unknown>).topics;
    delete (postPlanData as Record<string, unknown>).consultantProfile;
    delete (postPlanData as Record<string, unknown>).id;
    delete (postPlanData as Record<string, unknown>).createdAt;
    delete (postPlanData as Record<string, unknown>).updatedAt;

    const body: Record<string, unknown> = {
      ...postPlanData,
      consultantProfileId: consultantId,
      topics: allTopicIds ?? [],
    };

    Object.keys(body).forEach(
      (key) => body[key] === undefined && delete body[key],
    );
    return body as unknown as CreateClassPayload & { topics?: string[] };
  }

  /**
   * Format class contents for API submission
   */
  static formatClassContents(
    classContents: ClassContentInput[],
    _classPlanId: string,
    _now: Date,
  ): ClassContentInput[] {
    return classContents.map((content, index) => ({
      id: content.id ?? `temp-${index}`,
      title: content.title,
      description: content.description,
      contentType: content.contentType ?? null,
      contentUrl: content.contentUrl ?? null,
      order: content.order,
      hoursAllotted: content.hoursAllotted,
    }));
  }

  /**
   * Show success toast for class operations
   */
  static showSuccessToast(title: string, isUpdate: boolean): void {
    const action = isUpdate ? "Updated" : "Created";
    toast({
      title: "Success",
      description: `${action} class "${title}" successfully`,
    });
  }
}
