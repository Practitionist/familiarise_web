import { ClassEvent, Event, FormData, WebinarEvent } from "../types/event";
import { toast } from "@/hooks/use-toast";

/**
 * Service to manage events (webinars and classes)
 */
export class PlannerService {
  
  /**
   * Fetch webinars for a consultant
   */
  static async fetchWebinars(consultantId: string): Promise<WebinarEvent[]> {
    try {
      const response = await fetch(`/api/events/webinars?consultantProfileId=${consultantId}`);
      
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
      const response = await fetch(`/api/events/classes?consultantProfileId=${consultantId}`);
      
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
   * Save webinar data
   */
  static async saveWebinar(webinarData: Partial<WebinarEvent>, consultantId: string): Promise<WebinarEvent> {
    try {
      const response = await fetch("/api/events/webinars", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...webinarData,
          consultantProfileId: consultantId,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save webinar");
      }

      const { data } = await response.json();
      return {
        id: data.id,
        type: "webinar",
        webinarPlan: data.webinarPlan,
        appointment: data.appointment,
        waitlist: data.waitlist,
        meetingRoom: data.meetingRoom,
      };
    } catch (error) {
      console.error("Error saving webinar:", error);
      throw error;
    }
  }
  
  /**
   * Save class data
   */
  static async saveClass(classData: Partial<ClassEvent>, consultantId: string): Promise<ClassEvent> {
    try {
      const response = await fetch("/api/events/classes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...classData,
          consultantProfileId: consultantId,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save class");
      }

      const { data } = await response.json();
      return {
        id: data.id,
        type: "class",
        classPlan: data.classPlan,
        appointments: data.appointments,
        waitlist: data.waitlist,
        meetingRoom: data.meetingRoom,
      };
    } catch (error) {
      console.error("Error saving class:", error);
      throw error;
    }
  }
  
  /**
   * Get all available topics
   */
  static async getTopics(query?: string): Promise<Array<{ id: string; name: string; createdAt: Date; updatedAt: Date }>> {
    try {
      const url = new URL('/api/user/content/topics', window.location.origin);
      if (query) {
        url.searchParams.set('query', query);
      }
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to fetch topics');
      }
      
      const { data } = await response.json();
      return data;
    } catch (error) {
      console.error('Error fetching topics:', error);
      return [];
    }
  }
  
  /**
   * Create topics by name
   */
  static async createTopics(topicNames: string[]): Promise<string[]> {
    try {
      // Create an array of promises for creating each topic
      const promises = topicNames.map(async (name) => {
        // Create a new topic
        const topicResponse = await fetch('/api/user/content/topics', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name }),
        });
        
        if (!topicResponse.ok) {
          const errorData = await topicResponse.json();
          throw new Error(errorData.error || `Failed to create topic "${name}"`);
        }
        
        const topicData = await topicResponse.json();
        return topicData.data.id;
      });
      
      // Wait for all topics to be created
      const ids = await Promise.all(promises);
      
      if (ids.length > 0) {
        toast({
          title: "Topics created",
          description: `Successfully created ${ids.length} topics`,
        });
      }
      
      return ids;
    } catch (error) {
      console.error("Error creating topics:", error);
      toast({
        title: "Error creating topics",
        description: error instanceof Error ? error.message : "Unknown error occurred",
        variant: "destructive",
      });
      return [];
    }
  }
  
  /**
   * Validate class contents
   */
  static validateClassContents(contents: any[] | undefined): Record<string, string> {
    const errors: Record<string, string> = {};
    
    if (!contents || contents.length === 0) {
      return errors;
    }
    
    contents.forEach((content, index) => {
      if (!content.title) {
        errors[`classContents.${index}.title`] = "Title is required";
      }
      
      if (!content.description) {
        errors[`classContents.${index}.description`] = "Description is required";
      }
      
      if (!content.order || isNaN(Number(content.order)) || Number(content.order) <= 0) {
        errors[`classContents.${index}.order`] = "Order must be a positive number";
      }
      
      if (!content.hoursAllotted || isNaN(Number(content.hoursAllotted)) || Number(content.hoursAllotted) <= 0) {
        errors[`classContents.${index}.hoursAllotted`] = "Hours must be a positive number";
      }
    });
    return errors;
  }
  
  /**
   * Type guard to check if an event is a WebinarEvent
   */
  static isWebinarEvent(event: Event): event is WebinarEvent {
    return event.type === 'webinar';
  }
  
  /**
   * Type guard to check if an event is a ClassEvent 
   */
  static isClassEvent(event: Event): event is ClassEvent {
    return event.type === 'class';
  }
  
  /**
   * Process form data and save the event (webinar or class)
   */
  static async saveEventFromFormData(data: FormData, eventType: "webinar" | "class", initialData: Event | null, consultantId: string): Promise<Event> {
    try {
      console.log("Starting form submission with data:", JSON.stringify(data, null, 2));
      
      const finalTopicIds = await this.processTopics(data.topics);
      
      if (eventType === "webinar") {
        return await this.processWebinarData(data, initialData, consultantId, finalTopicIds);
      } else {
        return await this.processClassData(data, initialData, consultantId, finalTopicIds);
      }
    } catch (error) {
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
    
    // Check if topics are entered as text or existing IDs
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isFirstTopicString = typeof topics[0] === 'string' && topics[0]?.length > 0;
    const isFirstTopicUuid = isFirstTopicString && uuidPattern.test(topics[0]);
    
    // If topics are UUIDs, return them as is
    if (!isFirstTopicString || isFirstTopicUuid) {
      return topics;
    }
    
    // Process each topic name before creating
    const processedTopics = topics.map(topic => {
      // Remove extra whitespace and trim
      let processed = topic.trim().replace(/\s+/g, ' ');
      
      // Convert to sentence case (first letter uppercase, rest lowercase)
      processed = processed.toLowerCase();
      processed = processed.charAt(0).toUpperCase() + processed.slice(1);
      
      // Remove any special characters except spaces and alphanumeric
      processed = processed.replace(/[^a-zA-Z0-9\s]/g, '');
      
      return processed;
    }).filter(topic => 
      // Filter out empty topics and those less than 2 characters
      topic.length >= 2 &&
      // Filter out duplicates
      !topics.find(t => t !== topic && t.toLowerCase() === topic.toLowerCase())
    );
    
    // Create new topics with processed names
    const newIds = await this.createTopics(processedTopics);
    return newIds.length > 0 ? newIds : topics;
  }
  
  /**
   * Process and save webinar data
   */
  private static async processWebinarData(
    data: FormData, 
    initialData: Event | null, 
    consultantId: string, 
    topicIds: string[]
  ): Promise<WebinarEvent> {
    const now = new Date();
    const webinarId = initialData && this.isWebinarEvent(initialData) ? initialData.webinarPlan.id : "";
    const createdAt = initialData && this.isWebinarEvent(initialData) ? initialData.webinarPlan.createdAt : now;
    
    const webinarData = {
      type: "webinar" as const,
      webinarPlan: {
        id: webinarId,
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
        topics: this.formatTopics(topicIds, now),
        topicIds: topicIds,
        consultantProfileId: consultantId,
        consultantProfile: null,
        createdAt: createdAt,
        updatedAt: now,
      },
    };
    
    console.log("Saving webinar data:", webinarData);
    const savedWebinar = await this.saveWebinar(webinarData, consultantId);
    
    this.showSuccessToast(data.title, initialData, "webinar");
    return savedWebinar;
  }
  
  /**
   * Process and save class data
   */
  private static async processClassData(
    data: FormData, 
    initialData: Event | null, 
    consultantId: string, 
    topicIds: string[]
  ): Promise<ClassEvent> {
    const now = new Date();
    const classData = data as any;
    const classContents = classData.classContents || [];
    
    const classId = initialData && this.isClassEvent(initialData) ? initialData.classPlan.id : "";
    const createdAt = initialData && this.isClassEvent(initialData) ? initialData.classPlan.createdAt : now;
    
    const classEventData = {
      type: "class" as const,
      classPlan: {
        id: classId,
        title: data.title,
        description: data.description,
        price: data.price,
        durationInMonths: "durationInMonths" in data ? data.durationInMonths : 0,
        maxParticipants: data.maxParticipants,
        language: data.language,
        level: data.level,
        prerequisites: data.prerequisites ?? null,
        materialProvided: data.materialProvided ?? null,
        learningOutcomes: data.learningOutcomes,
        topics: this.formatTopics(topicIds, now),
        topicIds: topicIds,
        consultantProfileId: consultantId,
        consultantProfile: null,
        certificateProvided: "certificateProvided" in data ? data.certificateProvided : false,
        callsPerWeek: "callsPerWeek" in data ? data.callsPerWeek : 0,
        videoMeetings: "videoMeetings" in data ? data.videoMeetings : 0,
        emailSupport: "emailSupport" in data ? data.emailSupport : "GENERAL",
        classContents: this.formatClassContents(classContents, classId, now),
        createdAt: createdAt,
        updatedAt: now,
      },
    };
    
    console.log("Saving class data:", classEventData);
    
    try {
      const savedClass = await this.saveClass(classEventData, consultantId);
      this.showSuccessToast(data.title, initialData, "class");
      return savedClass;
    } catch (saveError) {
      console.error("Error in saveClass:", saveError);
      throw saveError;
    }
  }
  
  /**
   * Format topics for API submission
   */
  private static formatTopics(topicIds: string[], now: Date) {
    return topicIds.map(id => ({
      id,
      name: "",
      createdAt: now,
      updatedAt: now
    }));
  }
  
  /**
   * Format class contents for API submission
   */
  private static formatClassContents(classContents: any[], classId: string, now: Date) {
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
  private static showSuccessToast(title: string, initialData: Event | null, eventType: string) {
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
    const errorMessage = error instanceof Error ? 
      `${error.message}\n${error.stack}` : 
      "Unknown error occurred";
    console.error(errorMessage);
      
    toast({
      title: "Error",
      description: error instanceof Error ? error.message : "Failed to save. Please try again.",
      variant: "destructive",
    });
  }
} 