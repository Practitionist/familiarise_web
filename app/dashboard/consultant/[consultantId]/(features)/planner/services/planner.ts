import { ClassEvent, Event, FormData, WebinarEvent } from "../types/event";
import { toast } from "@/hooks/use-toast";

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
  static async fetchWebinars(consultantId: string): Promise<WebinarEvent[]> {
    try {
      const response = await fetch(
        `/api/events/webinars?consultantProfileId=${consultantId}`,
      );

      if (!response.ok) {
        throw new Error("Failed to fetch webinars");
      }

      const webinarsData = await response.json();

      return webinarsData.data.map((webinar: any) => ({
        id: webinar.id,
        type: "webinar" as const,
        webinarPlan: webinar.webinarPlan,
        appointment: webinar.appointment,
        waitlist: webinar.waitlist,
        meetingRoom: webinar.meetingRoom,
      }));
    } catch (error) {
      console.error("Error fetching webinars:", error);
      throw error;
    }
  }

  /**
   * Fetch classes for a consultant
   */
  static async fetchClasses(consultantId: string): Promise<ClassEvent[]> {
    try {
      const response = await fetch(
        `/api/events/classes?consultantProfileId=${consultantId}`,
      );

      if (!response.ok) {
        throw new Error("Failed to fetch classes");
      }

      const classesData = await response.json();

      return classesData.data.map((classEvent: any) => ({
        id: classEvent.id,
        type: "class" as const,
        classPlan: classEvent.classPlan,
        appointments: classEvent.appointments,
        waitlist: classEvent.waitlist,
        meetingRoom: classEvent.meetingRoom,
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
    consultantId: string,
  ): Promise<WebinarEvent> {
    try {
      // Reset tracking
      this.newlyCreatedTopicIds = [];
      this.newlyCreatedEventId = null;
      this.newlyCreatedEventType = null;

      // First check for duplicate title
      const title = webinarData.webinarPlan?.title;
      const planId = webinarData.webinarPlan?.id || "";
      const isUpdate = !!planId;
      const webinarId = webinarData.id || ""; // Get the webinar instance ID

      console.log(
        `${isUpdate ? "Updating" : "Creating"} webinar${isUpdate ? ` with plan ID ${planId}` : ""}${webinarId ? ` and instance ID ${webinarId}` : ""}...`,
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
          .map((topic) => (typeof topic === "string" ? topic : topic.name))
          .filter(Boolean);
      }

      // Prepare all topic ids list
      let allTopicIds: string[] = [];

      if (topicNames.length > 0) {
        try {
          console.log("Creating topics first:", topicNames);
          const newTopicIds = await this.createTopics(topicNames);
          this.newlyCreatedTopicIds = newTopicIds;
          allTopicIds = [...newTopicIds];
          console.log("Topics created with IDs:", newTopicIds);
        } catch (error) {
          console.error("Error creating topics:", error);
          throw new Error(
            "Failed to create topics: " +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      } else if (isUpdate) {
        // If no new topics are provided but we're updating, log this to avoid wiping out existing topics
        console.log(
          "No new topics provided for update. Existing topics will be preserved.",
        );
      }

      try {
        // Determine the endpoint and HTTP method based on whether this is an update or create
        const endpoint = "/api/events/webinars/create-with-plan";
        const method = isUpdate ? "PATCH" : "POST";

        console.log(
          `Using ${method} request to ${endpoint} for ${isUpdate ? "update" : "create"}`,
        );

        // Prepare the scheduled date if provided
        const scheduledAt = webinarData.webinarPlan?.scheduledAt;
        let scheduledAtDate = null;

        if (scheduledAt) {
          // Convert to Date object if it's a string
          scheduledAtDate =
            typeof scheduledAt === "string"
              ? new Date(scheduledAt)
              : (scheduledAt as unknown) instanceof Date
                ? scheduledAt
                : null;

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
            webinarId: webinarId, // Instance ID
            title: webinarData.webinarPlan?.title,
            description: webinarData.webinarPlan?.description,
            durationInHours: webinarData.webinarPlan?.durationInHours,
            price: webinarData.webinarPlan?.price,
            maxParticipants: webinarData.webinarPlan?.maxParticipants,
            language: webinarData.webinarPlan?.language,
            level: webinarData.webinarPlan?.level,
            prerequisites: webinarData.webinarPlan?.prerequisites,
            materialProvided: webinarData.webinarPlan?.materialProvided,
            learningOutcomes: webinarData.webinarPlan?.learningOutcomes,
            consultantProfileId: consultantId,
            scheduledAt: scheduledAtDate,
            // Determine topicIds value:
            // - If new topics were created/added (allTopicIds has content): send them.
            // - If no new topics were added AND the form's topics list was empty: send [].
            // - Otherwise (no new topics added, form had topics initially or wasn't touched): send undefined.
            topicIds:
              allTopicIds.length > 0
                ? allTopicIds
                : webinarData.webinarPlan?.topics?.length === 0
                  ? []
                  : undefined,
          };
          console.log(
            "Constructed PATCH request body:",
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
            topicIds: allTopicIds, // Send newly created/found topic IDs
          };
          console.log(
            "Constructed POST request body:",
            JSON.stringify(requestBody, null, 2),
          );
        }

        // Now create or update the webinar using the constructed body
        const response = await fetch(endpoint, {
          method,
          headers: {
            "Content-Type": "application/json",
          },
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

          return {
            id: webinar.id,
            type: "webinar",
            webinarPlan: webinar.webinarPlan,
            appointment: webinar.appointment,
            waitlist: webinar.waitlist,
            meetingRoom: webinar.meetingRoom,
          };
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
      console.error("Error saving webinar:", error);
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
      const planId = classData.classPlan?.id || "";
      const isUpdate = !!planId;
      const classId = classData.id || ""; // Get the class instance ID

      console.log(
        `${isUpdate ? "Updating" : "Creating"} class${isUpdate ? ` with plan ID ${planId}` : ""}${classId ? ` and instance ID ${classId}` : ""}...`,
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
          .map((topic) => (typeof topic === "string" ? topic : topic.name))
          .filter(Boolean);
      }

      // Prepare all topic ids list
      let allTopicIds: string[] = [];

      if (topicNames.length > 0) {
        try {
          console.log("Creating topics first:", topicNames);
          const newTopicIds = await this.createTopics(topicNames);
          this.newlyCreatedTopicIds = newTopicIds;
          allTopicIds = [...newTopicIds];
          console.log("Topics created with IDs:", newTopicIds);
        } catch (error) {
          console.error("Error creating topics:", error);
          throw new Error(
            "Failed to create topics: " +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      } else if (isUpdate) {
        // If no new topics are provided but we're updating, log this to avoid wiping out existing topics
        console.log(
          "No new topics provided for update. Existing topics will be preserved.",
        );
      }

      try {
        // Determine the endpoint and HTTP method based on whether this is an update or create
        const endpoint = "/api/events/classes/create-with-plan";
        const method = isUpdate ? "PATCH" : "POST";

        console.log(
          `Using ${method} request to ${endpoint} for ${isUpdate ? "update" : "create"}`,
        );

        // Construct payload carefully based on POST vs PATCH
        let requestBody: any = {};

        if (isUpdate) {
          // For PATCH, send only necessary fields + topicIds if available
          requestBody = {
            id: planId, // Plan ID
            classId: classId, // Instance ID
            title: classData.classPlan?.title,
            description: classData.classPlan?.description,
            durationInMonths: classData.classPlan?.durationInMonths,
            price: classData.classPlan?.price,
            maxParticipants: classData.classPlan?.maxParticipants,
            language: classData.classPlan?.language,
            level: classData.classPlan?.level,
            prerequisites: classData.classPlan?.prerequisites,
            materialProvided: classData.classPlan?.materialProvided,
            learningOutcomes: classData.classPlan?.learningOutcomes,
            certificateProvided: classData.classPlan?.certificateProvided,
            callsPerWeek: classData.classPlan?.callsPerWeek,
            videoMeetings: classData.classPlan?.videoMeetings,
            emailSupport: classData.classPlan?.emailSupport,
            classContents: classData.classPlan?.classContents, // Send updated contents
            consultantProfileId: consultantId,
            topicIds:
              allTopicIds.length > 0
                ? allTopicIds
                : classData.classPlan?.topics?.length === 0
                  ? []
                  : undefined,
          };
          console.log(
            "Constructed PATCH request body for Class:",
            JSON.stringify(requestBody, null, 2),
          );
        } else {
          // For POST, send all plan data + topicIds
          const postPlanData = { ...classData.classPlan };
          // Ensure nested topics array is removed before spreading
          delete postPlanData.topics;
          requestBody = {
            ...postPlanData,
            consultantProfileId: consultantId,
            topicIds: allTopicIds, // Send newly created/found topic IDs
          };
          console.log(
            "Constructed POST request body for Class:",
            JSON.stringify(requestBody, null, 2),
          );
        }

        const response = await fetch(endpoint, {
          method,
          headers: {
            "Content-Type": "application/json",
          },
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

          return {
            id: classEvent.id,
            type: "class",
            classPlan: classEvent.classPlan,
            appointments: classEvent.appointments,
            waitlist: classEvent.waitlist,
            meetingRoom: classEvent.meetingRoom,
          };
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
          "No valid topics after simplified processing and deduplication",
        );
        return []; // Return empty array if no valid topics remain
      }

      console.log("Requesting topics from backend:", uniqueTopicNames);

      // Create/retrieve all topics in a single request
      const response = await fetch("/api/user/content/topics", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ names: uniqueTopicNames }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to create topics");
      }

      const { data: topics } = await response.json();
      if (!Array.isArray(topics) || topics.length === 0) {
        throw new Error("Invalid response - no topics returned");
      }

      console.log("Topics created/retrieved:", topics);
      return topics.map((topic) => topic.id);
    } catch (error) {
      console.error("Error creating topics:", error);
      throw error;
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
    // Reset tracking for new transaction
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

    const webinarData = {
      type: "webinar" as const,
      id: webinarInstanceId, // Include the webinar instance ID for updates
      webinarPlan: {
        id: webinarPlanId,
        title: data.title,
        description: data.description,
        price: data.price,
        durationInHours: "durationInHours" in data ? data.durationInHours : 0,
        maxParticipants: data.maxParticipants,
        language: data.language,
        level: data.level,
        prerequisites: data.prerequisites ?? null,
        materialProvided: data.materialProvided ?? null,
        learningOutcomes: data.learningOutcomes,
        topics: topicIds.map((id) => ({
          id,
          name: Array.isArray(data.topics)
            ? data.topics.find((_, index) => index === topicIds.indexOf(id)) ||
              ""
            : "",
          createdAt: now,
          updatedAt: now,
        })),
        topicIds: topicIds,
        consultantProfileId: consultantId,
        consultantProfile: null,
        createdAt: createdAt,
        updatedAt: now,
        scheduledAt: (data as any).scheduledAt,
      },
    };

    console.log("Saving webinar data:", webinarData);

    const savedWebinar = await this.saveWebinar(webinarData, consultantId);
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
    // Reset tracking for new transaction
    this.newlyCreatedEventId = null;
    this.newlyCreatedEventType = null;

    const now = new Date();
    const classData = data as any;
    const classContents = classData.classContents || [];

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

    const classEventData = {
      type: "class" as const,
      id: classInstanceId, // Include the class instance ID for updates
      classPlan: {
        id: classPlanId,
        title: data.title,
        description: data.description,
        price: data.price,
        durationInMonths:
          "durationInMonths" in data ? data.durationInMonths : 0,
        maxParticipants: data.maxParticipants,
        language: data.language,
        level: data.level,
        prerequisites: data.prerequisites ?? null,
        materialProvided: data.materialProvided ?? null,
        learningOutcomes: data.learningOutcomes,
        topics: topicIds.map((id) => ({
          id,
          name: Array.isArray(data.topics)
            ? data.topics.find((_, index) => index === topicIds.indexOf(id)) ||
              ""
            : "",
          createdAt: now,
          updatedAt: now,
        })),
        topicIds: topicIds,
        consultantProfileId: consultantId,
        consultantProfile: null,
        certificateProvided:
          "certificateProvided" in data ? data.certificateProvided : false,
        callsPerWeek: "callsPerWeek" in data ? data.callsPerWeek : 0,
        videoMeetings: "videoMeetings" in data ? data.videoMeetings : 0,
        emailSupport: "emailSupport" in data ? data.emailSupport : "GENERAL",
        classContents: this.formatClassContents(
          classContents,
          classPlanId,
          now,
        ),
        createdAt: createdAt,
        updatedAt: now,
      },
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
    classId: string,
    now: Date,
  ) {
    return classContents.map((content: any, index: number) => ({
      id: content.id || `temp-${index}`,
      title: content.title,
      description: content.description,
      contentType: content.contentType || null,
      contentUrl: content.contentUrl || null,
      order: content.order,
      hoursAllotted: content.hoursAllotted,
      createdAt: now,
      updatedAt: now,
      classPlanId: classId,
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
