import { toast } from "@/hooks/use-toast";
import { ClassStatus, WebinarStatus } from "@prisma/client";
import { ClassEvent, Event, FormData, WebinarEvent } from "../types/event";

/**
 * Service to manage events (webinars and classes)
 */
export class PlannerService {
  // Track newly created topics to handle rollback
  private static newlyCreatedTopicIds: string[] = [];
  // Track newly created events to handle rollback
  private static newlyCreatedEventId: string | null = null;
  private static newlyCreatedEventType: "webinar" | "class" | null = null;

  /**
   * Check if a title already exists for a consultant
   */
  static async checkDuplicateTitle(
    title: string,
    consultantId: string,
    eventType:
      | "webinar"
      | "class"
      | "consultation"
      | "subscription"
      | "both" = "both",
    excludeId: string = "",
  ): Promise<boolean> {
    try {
      // For 'both' option, check webinars first, then classes
      if (eventType === "both") {
        const isWebinarDuplicate = await this.checkDuplicateTitle(
          title,
          consultantId,
          "webinar",
          excludeId,
        );
        if (isWebinarDuplicate) return true;

        const isClassDuplicate = await this.checkDuplicateTitle(
          title,
          consultantId,
          "class",
          excludeId,
        );
        return isClassDuplicate;
      }

      // Determine the appropriate endpoint based on event type
      let endpoint: string;

      switch (eventType) {
        case "webinar":
          endpoint = "/api/events/webinars/check-duplicate-title";
          break;
        case "class":
          endpoint = "/api/events/classes/check-duplicate-title";
          break;
        case "consultation":
          endpoint = "/api/events/consultations/check-duplicate-title";
          break;
        case "subscription":
          endpoint = "/api/events/subscriptions/check-duplicate-title";
          break;
        default:
          throw new Error(`Unsupported event type: ${eventType}`);
      }

      const params = new URLSearchParams({
        title,
        consultantProfileId: consultantId,
      });

      if (excludeId) {
        params.append("excludeId", excludeId);
      }

      const response = await fetch(`${endpoint}?${params}`);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error ||
            `Failed to check for duplicate ${eventType} titles`,
        );
      }

      const { isDuplicate } = await response.json();
      return isDuplicate;
    } catch (error) {
      console.error(`Error checking for duplicate ${eventType} title:`, error);
      return false; // In case of error, allow the save to proceed
    }
  }

  /**
   * Fetch webinars for a consultant
   */
  static async fetchWebinars(
    consultantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<WebinarEvent[]> {
    try {
      const params = new URLSearchParams({
        consultantProfileId: consultantId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });

      const response = await fetch(`/api/events/webinars?${params}`);

      if (!response.ok) {
        throw new Error("Failed to fetch webinars");
      }

      const webinarsData = await response.json();

      return webinarsData.data.map((webinar: any) => {
        // Extract the start time from the first slot, if available
        const startTimeString =
          webinar.appointment?.slotsOfAppointment?.[0]?.slotStartTimeInUTC;
        const scheduledAtDate = startTimeString
          ? new Date(startTimeString)
          : undefined;

        return {
          id: webinar.id,
          type: "webinar" as const,
          status: webinar.status,
          webinarPlan: webinar.webinarPlan,
          appointment: webinar.appointment,
          waitlist: webinar.waitlist,
          meetingRoom: webinar.meetingRoom,
          scheduledAt: scheduledAtDate,
          feedbackSummary: webinar.feedbackSummary,
        };
      });
    } catch (error) {
      console.error("Error fetching webinars:", error);
      throw error;
    }
  }

  /**
   * Fetch classes for a consultant
   */
  static async fetchClasses(
    consultantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<ClassEvent[]> {
    try {
      const params = new URLSearchParams({
        consultantProfileId: consultantId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });
      const response = await fetch(`/api/events/classes?${params}`);

      if (!response.ok) {
        throw new Error("Failed to fetch classes");
      }

      const classesData = await response.json();

      return classesData.data.map((classEvent: any) => ({
        id: classEvent.id,
        type: "class" as const,
        status: classEvent.status,
        startDate: classEvent.startDate,
        endDate: classEvent.endDate,
        classPlan: classEvent.classPlan,
        appointments: classEvent.appointments,
        waitlist: classEvent.waitlist,
        meetingRoom: classEvent.meetingRoom,
        recordingUrls: classEvent.recordingUrls,
        feedbackSummary: classEvent.feedbackSummary,
      }));
    } catch (error) {
      console.error("Error fetching classes:", error);
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
    try {
      // Reset tracking
      this.newlyCreatedTopicIds = [];
      this.newlyCreatedEventId = null;
      this.newlyCreatedEventType = null;

      // First check for duplicate title
      const title = webinarData.webinarPlan?.title;
      const planId = webinarData.webinarPlan?.id ?? "";
      const isUpdate = !!planId;
      const webinarId = webinarData.id ?? ""; // Get the webinar instance ID

      console.log(
        `[PlannerService.saveWebinar] ${isUpdate ? "Updating" : "Creating"} webinar${isUpdate ? ` with plan ID ${planId}` : ""}${webinarId ? ` and instance ID ${webinarId}` : ""}...`,
      );

      if (title) {
        const isDuplicate = await this.checkDuplicateTitle(
          title,
          consultantId,
          "webinar",
          planId,
        );

        if (isDuplicate) {
          throw new Error(
            `A webinar with title "${title}" already exists. Please use a different title.`,
          );
        }
      }

      // Extract topic names from webinarData
      let topicNames: string[] = [];

      if (webinarData.webinarPlan?.topics) {
        // Handle topics whether they are strings or objects
        topicNames = webinarData.webinarPlan.topics
          .map((topic) => (typeof topic === "string" ? topic : topic?.name)) // Safer access with optional chaining
          .filter(Boolean); // Filter out null/undefined names
      }
      console.log(
        "[PlannerService.saveWebinar] Extracted topic names from input data:",
        topicNames,
      );

      // Prepare all topic ids list
      let allTopicIds: string[] = [];

      if (topicNames.length > 0) {
        try {
          console.log(
            "[PlannerService.saveWebinar] Calling createTopics with names:",
            topicNames,
          );
          const newTopicIds = await this.createTopics(topicNames);
          this.newlyCreatedTopicIds = newTopicIds; // Track only newly created ones? createTopics might return existing ones too. Revisit if rollback logic needs adjustment.
          allTopicIds = [...newTopicIds]; // Assuming createTopics returns all relevant IDs (new + existing)
          console.log(
            "[PlannerService.saveWebinar] Received topic IDs from createTopics:",
            allTopicIds,
          );
        } catch (error) {
          console.error(
            "[PlannerService.saveWebinar] Error creating topics:",
            error,
          );
          throw new Error(
            "Failed to create topics: " +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      } else if (isUpdate) {
        console.log(
          "[PlannerService.saveWebinar] No topic names provided for update. Existing topics might be preserved or cleared depending on API logic.",
        );
      }

      try {
        // Determine the endpoint and HTTP method based on whether this is an update or create
        const endpoint = "/api/events/webinars/crud-with-plan";
        const method = isUpdate ? "PATCH" : "POST";

        console.log(
          `[PlannerService.saveWebinar] Using ${method} request to ${endpoint}`,
        );

        // Prepare the scheduled date if provided
        let scheduledAtDate = null;

        if (scheduledAt) {
          // Convert to Date object if it's a string
          if (typeof scheduledAt === "string") {
            scheduledAtDate = new Date(scheduledAt);
          } else if ((scheduledAt as unknown) instanceof Date) {
            scheduledAtDate = scheduledAt;
          } else {
            scheduledAtDate = null;
          }

          if (scheduledAtDate) {
            console.log(
              `Converting scheduledAt from local (${scheduledAtDate.toString()}) to UTC...`,
            );
            // Don't need to convert since the date object inherently handles the UTC conversion when sent as JSON
          }
        }

        // Construct payload carefully based on POST vs PATCH
        let requestBody: any = {};

        if (isUpdate) {
          // For PATCH, send only necessary fields + topicIds if available
          requestBody = {
            id: planId, // Plan ID
            webinarId: webinarId || undefined, // Instance ID or undefined
            title: webinarData.webinarPlan?.title,
            description: webinarData.webinarPlan?.description,
            price: webinarData.webinarPlan?.price,
            priceCurrency: webinarData.webinarPlan?.priceCurrency,
            certificateProvided: webinarData.webinarPlan?.certificateProvided,
            durationInHours:
              "durationInHours" in (webinarData.webinarPlan ?? {}) &&
              typeof webinarData.webinarPlan?.durationInHours === "number"
                ? webinarData.webinarPlan.durationInHours
                : undefined, // Only include if valid number
            maxParticipants: webinarData.webinarPlan?.maxParticipants,
            language: webinarData.webinarPlan?.language,
            level: webinarData.webinarPlan?.level,
            prerequisites: webinarData.webinarPlan?.prerequisites,
            materialProvided: webinarData.webinarPlan?.materialProvided,
            learningOutcomes: webinarData.webinarPlan?.learningOutcomes,
            consultantProfileId: consultantId, // Should this be optional for PATCH? API expects it currently. Keep for now.
            scheduledAt: scheduledAtDate,
            // API expects 'topicIds' for PATCH (inherited from POST schema definition)
            topicIds:
              allTopicIds.length > 0 // If we got IDs back from createTopics
                ? allTopicIds
                : topicNames.length === 0 // If input 'topicNames' was empty (explicit clear)
                  ? [] // Send empty array to clear topics
                  : undefined, // Otherwise (no change requested / error getting IDs?), send undefined
          };
          // Remove undefined fields before sending
          Object.keys(requestBody).forEach(
            (key) => requestBody[key] === undefined && delete requestBody[key],
          );

          console.log(
            "[PlannerService.saveWebinar] Constructed PATCH request body:",
            JSON.stringify(requestBody, null, 2),
          );
        } else {
          // For POST, send all plan data + topicIds
          const postPlanData = { ...webinarData.webinarPlan };
          // Ensure nested topics array is removed before spreading
          delete postPlanData.topics;
          requestBody = {
            ...postPlanData,
            consultantProfileId: consultantId,
            scheduledAt: scheduledAtDate,
            topicIds: allTopicIds, // Send newly created/found topic IDs (API expects topicIds)
          };
          // Remove undefined fields before sending
          Object.keys(requestBody).forEach(
            (key) => requestBody[key] === undefined && delete requestBody[key],
          );
          console.log(
            "[PlannerService.saveWebinar] Constructed POST request body:",
            JSON.stringify(requestBody, null, 2),
          );
        }

        // Now create or update the webinar using the constructed body
        console.log(
          `[PlannerService.saveWebinar] Sending ${method} request to ${endpoint}...`,
        );
        const response = await fetch(endpoint, {
          method,
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });
        console.log(
          `[PlannerService.saveWebinar] Received response status: ${response.status}`,
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(
            errorData.error ||
              `Failed to ${isUpdate ? "update" : "create"} webinar`,
          );
        }

        const { data: webinar } = await response.json();

        // Track the newly created webinar (for create operations only)
        if (!isUpdate) {
          this.newlyCreatedEventId = webinar.id;
          this.newlyCreatedEventType = "webinar";
        }

        // Additional processing for webinar if needed
        try {
          // Theoretical additional processing step that could fail
          // e.g., creating notifications, setting up calendar events, etc.

          // If all operations succeed, clear tracking
          this.newlyCreatedTopicIds = [];
          this.newlyCreatedEventId = null;
          this.newlyCreatedEventType = null;

          // Spread the properties from the API response and add the type
          // The API response (`webinar`) should conform to WebinarEventPayload
          return { ...webinar, type: "webinar" as const };
        } catch (postProcessError) {
          // If additional processing fails, rollback everything
          await this.rollbackTransaction();
          throw postProcessError;
        }
      } catch (error) {
        // If webinar creation failed, clean up any newly created topics
        await this.rollbackNewlyCreatedTopics();
        throw error;
      }
    } catch (error) {
      console.error("[PlannerService.saveWebinar] Overall error:", error);
      throw error;
    }
  }

  /**
   * Delete newly created topics if main operation fails
   */
  private static async rollbackNewlyCreatedTopics(): Promise<void> {
    if (this.newlyCreatedTopicIds.length === 0) {
      console.log("No topics to roll back");
      return;
    }

    try {
      console.log(
        "Rolling back newly created topics:",
        this.newlyCreatedTopicIds,
      );

      const response = await fetch("/api/user/content/topics", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids: this.newlyCreatedTopicIds }),
      });

      if (!response.ok) {
        console.error("Failed to rollback topics, status:", response.status);
        const errorData = await response.json();
        console.error("Rollback error:", errorData);
      } else {
        const result = await response.json();
        console.log("Topics rolled back successfully:", result);
        this.newlyCreatedTopicIds = [];
      }
    } catch (error) {
      console.error("Error during topic rollback:", error);
    }
  }

  /**
   * Save class data
   */
  static async saveClass(
    classData: Partial<ClassEvent>,
    consultantId: string,
  ): Promise<ClassEvent> {
    try {
      // Reset tracking
      this.newlyCreatedTopicIds = [];
      this.newlyCreatedEventId = null;
      this.newlyCreatedEventType = null;

      // First check for duplicate title
      const title = classData.classPlan?.title;
      const planId = classData.classPlan?.id ?? "";
      const isUpdate = !!planId;
      const classId = classData.id ?? ""; // Get the class instance ID

      console.log(
        `[PlannerService.saveClass] ${isUpdate ? "Updating" : "Creating"} class${isUpdate ? ` with plan ID ${planId}` : ""}${classId ? ` and instance ID ${classId}` : ""}...`,
      );

      if (title) {
        const isDuplicate = await this.checkDuplicateTitle(
          title,
          consultantId,
          "class",
          planId,
        );

        if (isDuplicate) {
          throw new Error(
            `A class with title "${title}" already exists. Please use a different title.`,
          );
        }
      }

      // Extract topic names from classData
      let topicNames: string[] = [];

      if (classData.classPlan?.topics) {
        // Handle topics whether they are strings or objects
        topicNames = classData.classPlan.topics
          .map((topic) => (typeof topic === "string" ? topic : topic?.name)) // Safer access
          .filter(Boolean); // Filter out null/undefined names
      }
      console.log(
        "[PlannerService.saveClass] Extracted topic names from input data:",
        topicNames,
      );

      // Prepare all topic ids list
      let allTopicIds: string[] = [];

      if (topicNames.length > 0) {
        try {
          console.log(
            "[PlannerService.saveClass] Calling createTopics with names:",
            topicNames,
          );
          const newTopicIds = await this.createTopics(topicNames);
          this.newlyCreatedTopicIds = newTopicIds; // See comment in saveWebinar about rollback
          allTopicIds = [...newTopicIds];
          console.log(
            "[PlannerService.saveClass] Received topic IDs from createTopics:",
            allTopicIds,
          );
        } catch (error) {
          console.error(
            "[PlannerService.saveClass] Error creating topics:",
            error,
          );
          throw new Error(
            "Failed to create topics: " +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      } else if (isUpdate) {
        console.log(
          "[PlannerService.saveClass] No topic names provided for update. Existing topics might be preserved or cleared.",
        );
      }

      try {
        // Determine the endpoint and HTTP method based on whether this is an update or create
        const endpoint = "/api/events/classes/crud-with-plan";
        const method = isUpdate ? "PATCH" : "POST";

        console.log(
          `[PlannerService.saveClass] Using ${method} request to ${endpoint}`,
        );

        // Construct payload carefully based on POST vs PATCH
        let requestBody: any = {};

        if (isUpdate) {
          // --- Linter Fix: Ensure classData.classPlan exists ---
          if (!classData.classPlan) {
            // This shouldn't logically happen if isUpdate is true, but handle defensively
            console.error(
              "[PlannerService.saveClass] Error: classData.classPlan is undefined during PATCH operation.",
            );
            throw new Error(
              "Internal error: Class plan data is missing during update.",
            );
          }
          // --- End Linter Fix ---

          requestBody = {
            id: planId, // Plan ID is guaranteed if isUpdate is true
            classId: classId || undefined, // Instance ID or undefined
            // Now safe to access classData.classPlan properties directly
            title: classData.classPlan.title,
            description: classData.classPlan.description,
            price: classData.classPlan.price,
            priceCurrency: classData.classPlan.priceCurrency,
            certificateProvided: classData.classPlan.certificateProvided,
            durationInMonths:
              "durationInMonths" in classData.classPlan &&
              typeof classData.classPlan.durationInMonths === "number"
                ? classData.classPlan.durationInMonths
                : undefined,
            maxParticipants: classData.classPlan.maxParticipants,
            language: classData.classPlan.language,
            level: classData.classPlan.level,
            prerequisites: classData.classPlan.prerequisites,
            materialProvided: classData.classPlan.materialProvided,
            learningOutcomes: classData.classPlan.learningOutcomes,
            emailSupport: classData.classPlan.emailSupport,
            callsPerWeek: classData.classPlan.callsPerWeek,
            videoMeetings: classData.classPlan.videoMeetings,
            classContents: classData.classPlan.classContents, // Send updated contents if provided
            consultantProfileId: consultantId, // Keep for now, API might require it
            // API expects 'topics' (containing IDs) for Class PATCH
            topics:
              allTopicIds.length > 0 // If we got IDs back
                ? allTopicIds
                : topicNames.length === 0 // If input 'topicNames' was empty
                  ? [] // Send empty array to clear topics
                  : undefined, // Otherwise, send undefined
          };
          // Remove undefined fields before sending
          Object.keys(requestBody).forEach(
            (key) => requestBody[key] === undefined && delete requestBody[key],
          );
          console.log(
            "[PlannerService.saveClass] Constructed PATCH request body:",
            JSON.stringify(requestBody, null, 2),
          );
        } else {
          // For POST
          const postPlanData = { ...classData.classPlan };
          delete postPlanData.topics;
          delete postPlanData.consultantProfile;
          delete postPlanData.id;
          delete postPlanData.createdAt;
          delete postPlanData.updatedAt;
          requestBody = {
            ...postPlanData,
            consultantProfileId: consultantId,
            topics: allTopicIds ?? [], // Send topic IDs (API expects 'topics' key with IDs)
          };
          // Remove undefined fields before sending
          Object.keys(requestBody).forEach(
            (key) => requestBody[key] === undefined && delete requestBody[key],
          );
          console.log(
            "[PlannerService.saveClass] Constructed POST request body:",
            JSON.stringify(requestBody, null, 2),
          );
        }
        console.log(
          `[PlannerService.saveClass] Sending ${method} request to ${endpoint}...`,
        );
        const response = await fetch(endpoint, {
          method,
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });
        console.log(
          `[PlannerService.saveClass] Received response status: ${response.status}`,
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(
            errorData.error ||
              `Failed to ${isUpdate ? "update" : "create"} class`,
          );
        }

        const { data: classEvent } = await response.json();

        // Track the newly created class (for create operations only)
        if (!isUpdate) {
          this.newlyCreatedEventId = classEvent.id;
          this.newlyCreatedEventType = "class";
        }

        // Additional processing for class if needed
        try {
          // Theoretical additional processing step that could fail
          // e.g., creating notifications, setting up calendar events, etc.

          // If all operations succeed, clear tracking
          this.newlyCreatedTopicIds = [];
          this.newlyCreatedEventId = null;
          this.newlyCreatedEventType = null;

          // Spread the properties from the API response and add the type
          // The API response (`classEvent`) should conform to ClassEventPayload
          return { ...classEvent, type: "class" as const };
        } catch (postProcessError) {
          // If additional processing fails, rollback everything
          await this.rollbackTransaction();
          throw postProcessError;
        }
      } catch (error) {
        console.log("Error saving class:", error);
        // If class creation failed, clean up any newly created topics
        await this.rollbackNewlyCreatedTopics();
        throw error;
      }
    } catch (error) {
      console.error("Error saving class:", error);
      throw error;
    }
  }

  /**
   * Get all available topics
   */
  static async getTopics(
    query?: string,
  ): Promise<
    Array<{ id: string; name: string; createdAt: Date; updatedAt: Date }>
  > {
    try {
      const url = new URL("/api/user/content/topics", window.location.origin);
      if (query) {
        url.searchParams.set("query", query);
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("Failed to fetch topics");
      }

      const { data } = await response.json();
      return data;
    } catch (error) {
      console.error("Error fetching topics:", error);
      return [];
    }
  }

  /**
   * Create topics by name
   */
  static async createTopics(topicNames: string[]): Promise<string[]> {
    try {
      if (!Array.isArray(topicNames) || topicNames.length === 0) {
        console.log("[PlannerService.createTopics] No topic names provided.");
        return [];
      }

      // Simplify topic processing: Trim whitespace and filter out empty/short strings.
      // Let the backend handle existence checks, creation, and case sensitivity.
      const processedTopics = topicNames
        .map((topic) => topic.trim()) // Trim whitespace
        .filter((topic) => topic && topic.length >= 2); // Filter empty and short strings

      // Deduplicate names before sending to backend (case-insensitive)
      const uniqueTopicNames = processedTopics.reduce((acc, current) => {
        const lowerCaseName = current.toLowerCase();
        if (!acc.some((item) => item.toLowerCase() === lowerCaseName)) {
          acc.push(current);
        }
        return acc;
      }, [] as string[]);

      if (uniqueTopicNames.length === 0) {
        console.log(
          "[PlannerService.createTopics] No valid unique topic names after processing.",
        );
        return []; // Return empty array if no valid topics remain
      }

      console.log(
        "[PlannerService.createTopics] Requesting topics from backend with names:",
        uniqueTopicNames,
      );

      // Create/retrieve all topics in a single request
      const response = await fetch("/api/user/content/topics", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ names: uniqueTopicNames }),
      });

      console.log(
        `[PlannerService.createTopics] API response status: ${response.status}`,
      );

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ error: "Failed to parse error response" }));
        console.error(
          "[PlannerService.createTopics] API error response:",
          errorData,
        );
        throw new Error(errorData.error || "Failed to create topics via API");
      }

      const { data: topics } = await response.json();
      if (!Array.isArray(topics)) {
        // Simplified check
        console.error(
          "[PlannerService.createTopics] Invalid API response format - 'data' is not an array:",
          topics,
        );
        throw new Error("Invalid response format from topic creation API");
      }

      console.log(
        "[PlannerService.createTopics] Topics received from API:",
        topics,
      );
      const topicIds = topics.map((topic) => topic.id);
      console.log(
        "[PlannerService.createTopics] Returning topic IDs:",
        topicIds,
      );
      return topicIds;
    } catch (error) {
      console.error("[PlannerService.createTopics] Error:", error);
      throw error; // Re-throw the error
    }
  }

  /**
   * Type guard to check if an event is a WebinarEvent
   */
  static isWebinarEvent(event: Event): event is WebinarEvent {
    return event.type === "webinar";
  }

  /**
   * Type guard to check if an event is a ClassEvent
   */
  static isClassEvent(event: Event): event is ClassEvent {
    return event.type === "class";
  }

  /**
   * Process form data and save the event (webinar or class)
   */
  static async saveEventFromFormData(
    data: FormData,
    eventType: "webinar" | "class",
    initialData: Event | null,
    consultantId: string,
  ): Promise<Event> {
    // Reset all tracking at the start of a transaction
    this.newlyCreatedTopicIds = [];
    this.newlyCreatedEventId = null;
    this.newlyCreatedEventType = null;

    try {
      console.log(
        "Starting form submission with data:",
        JSON.stringify(data, null, 2),
      );

      // Step 1: Process topics
      let finalTopicIds: string[] = [];
      try {
        finalTopicIds = await this.processTopics(data.topics);
      } catch (topicError) {
        console.error("Error processing topics:", topicError);
        this.handleSaveError(topicError);
        throw topicError;
      }

      // Step 2: Process and save the event
      try {
        if (eventType === "webinar") {
          return await this.processWebinarData(
            data,
            initialData,
            consultantId,
            finalTopicIds,
          );
        } else {
          return await this.processClassData(
            data,
            initialData,
            consultantId,
            finalTopicIds,
          );
        }
      } catch (eventError) {
        // Ensure we rollback any created resources
        await this.rollbackTransaction();
        this.handleSaveError(eventError);
        throw eventError;
      }
    } catch (error) {
      // This is the final catch-all error handler
      this.handleSaveError(error);
      throw error;
    }
  }

  /**
   * Process topics from form data
   */
  private static async processTopics(topics: string[]): Promise<string[]> {
    if (!Array.isArray(topics) || topics.length === 0) {
      return [];
    }

    // Process each topic name before creating
    const processedTopics = topics
      .map((topic) => {
        // Remove extra whitespace and trim
        let processed = topic.trim().replace(/\s+/g, " ");

        // Convert to sentence case (first letter uppercase, rest lowercase)
        processed = processed.toLowerCase();
        processed = processed.charAt(0).toUpperCase() + processed.slice(1);

        // Remove any special characters except spaces and alphanumeric
        processed = processed.replace(/[^a-zA-Z0-9\s]/g, "");

        return processed;
      })
      .filter(
        (topic) =>
          // Filter out empty topics and those less than 2 characters
          topic.length >= 2 &&
          // Filter out duplicates
          !topics.find(
            (t) => t !== topic && t.toLowerCase() === topic.toLowerCase(),
          ),
      );

    // Create new topics with processed names
    const newIds = await this.createTopics(processedTopics);
    return newIds.length > 0 ? newIds : [];
  }

  /**
   * Process and save webinar data
   */
  private static async processWebinarData(
    data: FormData,
    initialData: Event | null,
    consultantId: string,
    topicIds: string[],
  ): Promise<WebinarEvent> {
    this.newlyCreatedEventId = null;
    this.newlyCreatedEventType = null;

    const now = new Date();
    const webinarPlanId =
      initialData && this.isWebinarEvent(initialData)
        ? initialData.webinarPlan.id
        : "";
    const webinarInstanceId =
      initialData && this.isWebinarEvent(initialData) ? initialData.id : "";
    const createdAt =
      initialData && this.isWebinarEvent(initialData)
        ? initialData.webinarPlan.createdAt
        : now;

    // Construct the event data ensuring all required fields are present and match Partial<WebinarEvent>
    const webinarData: Partial<WebinarEvent> = {
      type: "webinar" as const,
      id: webinarInstanceId || undefined,
      webinarPlan: {
        // Base Plan fields
        id: webinarPlanId,
        title: data.title,
        description: data.description ?? "",
        price: data.price,
        priceCurrency: data.priceCurrency ?? "INR",
        maxParticipants: data.maxParticipants,
        language: data.language ?? "English",
        level: data.level ?? "Beginner",
        prerequisites: data.prerequisites ?? null,
        materialProvided: data.materialProvided ?? null,
        learningOutcomes: data.learningOutcomes ?? [],
        // Relationships
        consultantProfileId: consultantId, // Required for creation/update context
        consultantProfile: null, // Set to null as expected by type
        topics: topicIds.map((id) => ({
          id,
          name: "",
          createdAt: now,
          updatedAt: now,
        })),
        // Webinar specific plan fields
        durationInHours:
          typeof data.durationInHours === "number" ? data.durationInHours : 1,
        certificateProvided: data.certificateProvided ?? false,
        // Timestamps
        createdAt: createdAt,
        updatedAt: now,
      },
      // Other optional root fields for WebinarEvent
      status: WebinarStatus.SCHEDULED, // Provide a default status if needed
      feedbackSummary: null,
      appointment: undefined, // Let the API handler manage appointment creation/update
      waitlist: undefined,
      meetingRoom: undefined,
    };

    console.log("Saving webinar data:", webinarData);

    const savedWebinar = await this.saveWebinar(
      webinarData,
      data.scheduledAt,
      consultantId,
    );
    this.showSuccessToast(data.title, initialData, "webinar");
    return savedWebinar;

    // Note: All rollbacks are handled in saveWebinar if an error occurs
  }

  /**
   * Process and save class data
   */
  private static async processClassData(
    data: FormData,
    initialData: Event | null,
    consultantId: string,
    topicIds: string[],
  ): Promise<ClassEvent> {
    this.newlyCreatedEventId = null;
    this.newlyCreatedEventType = null;

    const now = new Date();
    const classDataForm = data;

    const classPlanId =
      initialData && this.isClassEvent(initialData)
        ? initialData.classPlan.id
        : "";
    const classInstanceId =
      initialData && this.isClassEvent(initialData) ? initialData.id : "";
    const createdAt =
      initialData && this.isClassEvent(initialData)
        ? initialData.classPlan.createdAt
        : now;

    // Construct the event data ensuring all required fields are present and match Partial<ClassEvent>
    const classEventData: Partial<ClassEvent> = {
      type: "class" as const,
      id: classInstanceId || undefined,
      classPlan: {
        // Base Plan fields
        id: classPlanId,
        title: classDataForm.title,
        description: classDataForm.description ?? "",
        price: classDataForm.price,
        priceCurrency: classDataForm.priceCurrency ?? "INR",
        maxParticipants: classDataForm.maxParticipants,
        language: classDataForm.language ?? "English",
        level: classDataForm.level ?? "Beginner",
        prerequisites: classDataForm.prerequisites ?? null,
        materialProvided: classDataForm.materialProvided ?? null,
        learningOutcomes: classDataForm.learningOutcomes ?? [],
        // Relationships
        consultantProfileId: consultantId, // Required for context
        consultantProfile: null, // Set to null as expected by type
        topics: topicIds.map((id) => ({
          id,
          name: "",
          createdAt: now,
          updatedAt: now,
        })),
        classContents: this.formatClassContents(
          classDataForm.classContents ?? [],
          classPlanId,
          now,
        ),
        // Class specific plan fields
        certificateProvided: classDataForm.certificateProvided ?? false,
        durationInMonths:
          typeof classDataForm.durationInMonths === "number"
            ? classDataForm.durationInMonths
            : 1,
        callsPerWeek:
          typeof classDataForm.callsPerWeek === "number"
            ? classDataForm.callsPerWeek
            : 1,
        videoMeetings:
          typeof classDataForm.videoMeetings === "number"
            ? classDataForm.videoMeetings
            : 1,
        emailSupport: classDataForm.emailSupport ?? "GENERAL",
        // Timestamps
        createdAt: createdAt,
        updatedAt: now,
      },
      // Other optional root fields for ClassEvent
      startDate: undefined, // Let API handle based on logic
      endDate: undefined, // Let API handle based on logic
      status: ClassStatus.SCHEDULED, // Provide default status
      recordingUrls: [],
      feedbackSummary: null,
      appointments: undefined,
      waitlist: undefined,
      meetingRoom: undefined,
    };

    console.log("Saving class data:", classEventData);

    const savedClass = await this.saveClass(classEventData, consultantId);
    this.showSuccessToast(data.title, initialData, "class");
    return savedClass;

    // Note: All rollbacks are handled in saveClass if an error occurs
  }

  /**
   * Format topics for API submission
   */
  private static formatTopics(topicIds: string[], now: Date) {
    return topicIds.map((id) => ({
      id,
      name: "",
      createdAt: now,
      updatedAt: now,
    }));
  }

  /**
   * Format class contents for API submission
   */
  private static formatClassContents(
    classContents: any[],
    classPlanId: string,
    now: Date,
  ) {
    return classContents.map((content: any, index: number) => ({
      id: content.id ?? `temp-${index}`,
      title: content.title,
      description: content.description,
      contentType: content.contentType ?? null,
      contentUrl: content.contentUrl ?? null,
      order: content.order,
      hoursAllotted: content.hoursAllotted,
      createdAt: now,
      updatedAt: now,
      classPlanId: classPlanId,
    }));
  }

  /**
   * Display a success toast notification
   */
  private static showSuccessToast(
    title: string,
    initialData: Event | null,
    eventType: string,
  ) {
    const action = initialData ? "Updated" : "Created";
    toast({
      title: "Success",
      description: `${action} ${eventType} "${title}" successfully`,
    });
  }

  /**
   * Handle errors during save operation
   */
  private static handleSaveError(error: unknown) {
    console.error("Error saving plan:", error);

    // Show detailed error info
    const errorMessage =
      error instanceof Error
        ? `${error.message}\n${error.stack}`
        : "Unknown error occurred";
    console.error(errorMessage);

    toast({
      title: "Error",
      description:
        error instanceof Error
          ? error.message
          : "Failed to save. Please try again.",
      variant: "destructive",
    });
  }

  /**
   * Delete newly created event if a later operation fails
   */
  private static async rollbackNewlyCreatedEvent(): Promise<void> {
    if (!this.newlyCreatedEventId || !this.newlyCreatedEventType) {
      console.log("No event to roll back");
      return;
    }

    try {
      console.log(
        `Rolling back newly created ${this.newlyCreatedEventType}:`,
        this.newlyCreatedEventId,
      );

      const endpoint =
        this.newlyCreatedEventType === "webinar"
          ? "/api/events/webinars"
          : "/api/events/classes";

      const response = await fetch(`${endpoint}/${this.newlyCreatedEventId}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        console.error(
          `Failed to rollback ${this.newlyCreatedEventType}, status:`,
          response.status,
        );
        const errorData = await response.json();
        console.error("Rollback error:", errorData);
      } else {
        const result = await response.json();
        console.log(
          `${this.newlyCreatedEventType} rolled back successfully:`,
          result,
        );
        this.newlyCreatedEventId = null;
        this.newlyCreatedEventType = null;
      }
    } catch (error) {
      console.error(
        `Error during ${this.newlyCreatedEventType} rollback:`,
        error,
      );
    }
  }

  /**
   * Rollback all created resources in reverse order
   */
  private static async rollbackTransaction(): Promise<void> {
    // First rollback event (if created)
    await this.rollbackNewlyCreatedEvent();
    // Then rollback topics (if created)
    await this.rollbackNewlyCreatedTopics();
  }
}
