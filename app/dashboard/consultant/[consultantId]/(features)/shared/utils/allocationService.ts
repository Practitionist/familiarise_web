import { TimeSlot } from "./calendarUtils";

export interface AllocationRequest {
  isAuto: boolean;
  slots?: string[];
  useRequestedSlots?: boolean;
}

export interface ValidationResult {
  conflicts: Array<{
    slot: string;
    existingAppointment: {
      type: string;
      with: string;
      time: string;
    };
  }>;
  outsideAvailability: Array<{
    slot: string;
  }>;
  validSlots: string[];
}

export interface AllocationResponse {
  success: boolean;
  data?: any;
  error?: string;
}

export interface ValidationResponse {
  success: boolean;
  data?: ValidationResult;
  error?: string;
}

/**
 * AllocationService - Pure API Client for Event Slot Management
 *
 * Handles all HTTP communication for slot allocation, validation,
 * and related operations. This is a pure API client with no business logic.
 *
 * Features:
 * - Slot allocation for consultations, subscriptions, webinars, classes
 * - Slot validation with conflict and availability checking
 * - Consultant data and availability fetching
 * - Appointment querying
 * - Consistent error handling and response format
 *
 * @example
 * ```ts
 * // Allocate slots
 * const result = await AllocationService.allocateSlots(
 *   "consultation",
 *   consultationId,
 *   slots,
 *   { isAuto: false }
 * );
 *
 * // Validate slots
 * const validation = await AllocationService.validateSlots(
 *   "subscription",
 *   subscriptionId,
 *   slots
 * );
 * ```
 */
export class AllocationService {
  /**
   * Allocates slots for consultations
   */
  static async allocateConsultationSlots(
    consultationId: string,
    request: AllocationRequest,
  ): Promise<AllocationResponse> {
    try {
      const response = await fetch(
        `/api/events/consultations/${consultationId}/allocate`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || "Failed to allocate consultation slots",
        };
      }

      return {
        success: true,
        data: data.data,
      };
    } catch (error) {
      console.error("Error allocating consultation slots:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  }

  /**
   * Validates slots for consultations
   */
  static async validateConsultationSlots(
    consultationId: string,
    slots: string[],
  ): Promise<ValidationResponse> {
    try {
      const response = await fetch(
        `/api/events/consultations/${consultationId}/validate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ slots }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || "Failed to validate consultation slots",
        };
      }

      return {
        success: true,
        data: data.data,
      };
    } catch (error) {
      console.error("Error validating consultation slots:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  }

  /**
   * Allocates slots for subscriptions
   */
  static async allocateSubscriptionSlots(
    subscriptionId: string,
    request: AllocationRequest,
  ): Promise<AllocationResponse> {
    try {
      const response = await fetch(
        `/api/events/subscriptions/${subscriptionId}/allocate`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || "Failed to allocate subscription slots",
        };
      }

      return {
        success: true,
        data: data.data,
      };
    } catch (error) {
      console.error("Error allocating subscription slots:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  }

  /**
   * Validates slots for subscriptions
   */
  static async validateSubscriptionSlots(
    subscriptionId: string,
    slots: string[],
  ): Promise<ValidationResponse> {
    try {
      const response = await fetch(
        `/api/events/subscriptions/${subscriptionId}/validate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ slots }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || "Failed to validate subscription slots",
        };
      }

      return {
        success: true,
        data: data.data,
      };
    } catch (error) {
      console.error("Error validating subscription slots:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  }

  /**
   * Allocates slots for webinars
   */
  static async allocateWebinarSlots(
    webinarId: string,
    request: AllocationRequest,
  ): Promise<AllocationResponse> {
    try {
      const response = await fetch(
        `/api/events/webinars/${webinarId}/allocate`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || "Failed to allocate webinar slots",
        };
      }

      return {
        success: true,
        data: data.data,
      };
    } catch (error) {
      console.error("Error allocating webinar slots:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  }

  /**
   * Allocates slots for classes
   */
  static async allocateClassSlots(
    classId: string,
    request: AllocationRequest,
  ): Promise<AllocationResponse> {
    try {
      const response = await fetch(`/api/events/classes/${classId}/allocate`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || "Failed to allocate class slots",
        };
      }

      return {
        success: true,
        data: data.data,
      };
    } catch (error) {
      console.error("Error allocating class slots:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  }

  /**
   * Generic allocation method that routes to the appropriate service
   */
  static async allocateSlots(
    eventType: "consultation" | "subscription" | "webinar" | "class",
    eventId: string,
    slots: TimeSlot[],
    allocationOptions?: {
      isAuto?: boolean;
      useRequestedSlots?: boolean;
    },
  ): Promise<AllocationResponse> {
    const slotStrings = slots.map((slot) => slot.startTime.toISOString());

    // Build the request object consistently for all event types
    const request: AllocationRequest = {
      isAuto: allocationOptions?.isAuto || false,
      slots: slotStrings,
      useRequestedSlots: allocationOptions?.useRequestedSlots,
    };

    switch (eventType) {
      case "consultation":
        return this.allocateConsultationSlots(eventId, request);

      case "subscription":
        return this.allocateSubscriptionSlots(eventId, request);

      case "webinar":
        return this.allocateWebinarSlots(eventId, request);

      case "class":
        return this.allocateClassSlots(eventId, request);

      default:
        return {
          success: false,
          error: "Invalid event type",
        };
    }
  }

  /**
   * Validates slots for classes
   */
  static async validateClassSlots(
    classId: string,
    slots: string[],
  ): Promise<ValidationResponse> {
    try {
      const response = await fetch(`/api/events/classes/${classId}/validate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slots }),
      });

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || "Failed to validate class slots",
        };
      }

      return {
        success: true,
        data: data.data,
      };
    } catch (error) {
      console.error("Error validating class slots:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  }

  /**
   * Validates slots for webinars
   */
  static async validateWebinarSlots(
    webinarId: string,
    slots: string[],
  ): Promise<ValidationResponse> {
    try {
      const response = await fetch(
        `/api/events/webinars/${webinarId}/validate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ slots }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || "Failed to validate webinar slots",
        };
      }

      return {
        success: true,
        data: data.data,
      };
    } catch (error) {
      console.error("Error validating webinar slots:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  }

  /**
   * Generic validation method that routes to the appropriate service
   */
  static async validateSlots(
    eventType: "consultation" | "subscription" | "webinar" | "class",
    eventId: string,
    slots: TimeSlot[],
  ): Promise<ValidationResponse> {
    const slotStrings = slots.map((slot) => slot.startTime.toISOString());

    console.log(`[AllocationService] Validating ${slotStrings.length} slots for ${eventType}:`, {
      eventId,
      slots: slotStrings.slice(0, 3), // Log first 3 for debugging
    });

    switch (eventType) {
      case "consultation":
        return this.validateConsultationSlots(eventId, slotStrings);

      case "subscription":
        return this.validateSubscriptionSlots(eventId, slotStrings);

      case "class":
        return this.validateClassSlots(eventId, slotStrings);

      case "webinar":
        return this.validateWebinarSlots(eventId, slotStrings);

      default:
        return {
          success: false,
          error: "Validation not supported for this event type",
        };
    }
  }

  /**
   * Fetches consultant data
   */
  static async fetchConsultantData(consultantId: string) {
    try {
      const response = await fetch(`/api/user/consultants/${consultantId}`);

      if (!response.ok) {
        throw new Error("Failed to fetch consultant data");
      }

      const { data } = await response.json();
      return data;
    } catch (error) {
      console.error("Error fetching consultant data:", error);
      throw error;
    }
  }

  /**
   * Fetches consultant availability slots (weekly and custom)
   */
  static async fetchAvailabilitySlots(
    consultantId: string,
    startDate: Date,
    endDate: Date,
    /**
     * Explicit timezone override. If omitted we fall back to the browser's
     * locale (when running on the client) and finally to "UTC".  This keeps
     * the API response aligned with the user's calendar view.
     */
    timezone?: string,
  ) {
    if (!consultantId) {
      throw new Error("Consultant ID is required");
    }

    // Resolve the timezone to send to the server.  Priority:
    //   1. Explicit argument
    //   2. Browser-reported tz (client-side)
    //   3. "UTC" (safe default on server or SSR)
    const tz =
      timezone ||
      (typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined) ||
      "UTC";

    try {
      const params = new URLSearchParams({
        startDateInUtc: startDate.toISOString(),
        endDateInUtc: endDate.toISOString(),
        timezone: tz,
      });
      const response = await fetch(
        `/api/slots/availability-with-allocation/${consultantId}?${params}`,
      );
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to fetch availability slots",
        );
      }
      const result = await response.json();
      const { data: slotsByDate } = result;

      // Flatten the grouped-by-date slots into a single array
      const allSlots: any[] = Object.values(slotsByDate).flat();

      return {
        weekly: allSlots.filter((s) => s.type === "WEEKLY"),
        custom: allSlots.filter((s) => s.type === "CUSTOM"),
      };
    } catch (error) {
      console.error("Error fetching availability slots:", error);
      throw error;
    }
  }

  /**
   * Fetches all appointments for a consultant
   */
  static async fetchAppointments(
    consultantId: string,
    startDate: Date,
    endDate: Date,
  ) {
    if (!consultantId) {
      throw new Error("Consultant ID is required");
    }

    try {
      const params = new URLSearchParams({
        consultantProfileId: consultantId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });
      const response = await fetch(`/api/slots/appointments?${params}`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to fetch appointments");
      }
      const { data } = await response.json();
      return data || [];
    } catch (error) {
      console.error("Error fetching appointments:", error);
      throw error;
    }
  }

  /**
   * Fetches specific event slots for any event type
   * Used to display "This Event" (black) instead of "Booked" (gray) in calendar
   */
  static async fetchEventSlots(
    eventType: "consultation" | "subscription" | "webinar" | "class",
    eventId: string,
  ) {
    try {
      const params = new URLSearchParams({
        type: eventType.toUpperCase(),
      });

      // Add the appropriate ID parameter based on event type
      if (eventType === "webinar") {
        params.append("webinarId", eventId);
      } else if (eventType === "class") {
        params.append("classId", eventId);
      } else if (eventType === "subscription") {
        params.append("subscriptionId", eventId);
      } else if (eventType === "consultation") {
        params.append("consultationId", eventId);
      }

      const response = await fetch(`/api/slots/appointments?${params}`);

      if (!response.ok) {
        throw new Error("Failed to fetch event slots");
      }

      const { data } = await response.json();
      return data || [];
    } catch (error) {
      console.error("Error fetching event slots:", error);
      throw error;
    }
  }
}
