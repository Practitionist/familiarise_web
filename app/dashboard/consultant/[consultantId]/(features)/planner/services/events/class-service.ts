/**
 * Service for managing classes
 */

import { toast } from "@/hooks/use-toast";
import { ClassEvent } from "../../types/event";
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
   * API returns topics as string[] - no transformation needed
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
      // API returns topics as strings, just add type discriminant
      return data.map((classEvent: ClassEvent) => ({
        ...classEvent,
        type: "class" as const,
      }));
    } catch (error) {
      console.error("[ClassService.fetchClasses] Error:", error);
      throw error;
    }
  }

  /**
   * Save class data
   * API handles topic creation/lookup - just send topic names
   */
  static async saveClass(
    classData: Partial<ClassEvent>,
    consultantId: string,
  ): Promise<ClassEvent> {
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

      const endpoint = "/api/events/classes/crud-with-plan";
      const method = isUpdate ? "PATCH" : "POST";

      const topicNames = classData.classPlan?.topics ?? [];
      const requestBody = this.buildRequestBody(
        classData,
        consultantId,
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
      return { ...classEvent, type: "class" as const };
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
   * Build request body for API
   * API accepts topic names directly - no ID conversion needed
   */
  private static buildRequestBody(
    classData: Partial<ClassEvent>,
    consultantId: string,
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
        // Send topic names - API handles finding/creating IDs
        topics: topicNames,
      };

      Object.keys(body).forEach(
        (key) => body[key] === undefined && delete body[key],
      );
      return body as unknown as CreateClassPayload & { id?: string; classId?: string; topics?: string[] };
    }

    // POST request - use destructuring to exclude unwanted fields
    const {
      topics: _topics,
      consultantProfile: _consultantProfile,
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...postPlanData
    } = plan || {};

    const body: Record<string, unknown> = {
      ...postPlanData,
      consultantProfileId: consultantId,
      // Send topic names - API handles finding/creating IDs
      topics: topicNames,
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
