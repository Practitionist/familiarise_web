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
      
      // Process topics if they are entered as text
      const topicNames = (Array.isArray(data.topics) && data.topics.length > 0 && 
          typeof data.topics[0] === 'string' && 
          data.topics[0]?.length > 0 && 
          !data.topics[0].match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i))
        ? data.topics as string[]
        : [];
      
      // If we have new topic names, create them and get their IDs
      let finalTopicIds = data.topics as string[];
      if (topicNames.length > 0) {
        const newIds = await this.createTopics(topicNames);
        finalTopicIds = newIds.length > 0 ? newIds : finalTopicIds;
      }
      
      const now = new Date();
      
      // Create event data object based on type
      if (eventType === "webinar") {
        const webinarData = {
          type: "webinar" as const,
          webinarPlan: {
            id: initialData && this.isWebinarEvent(initialData) ? initialData.webinarPlan.id : "",
            title: data.title,
            description: data.description,
            price: data.price,
            durationInHours:
              "durationInHours" in data ? data.durationInHours : 0,
            maxParticipants: data.maxParticipants,
            language: data.language,
            level: data.level,
            prerequisites: data.prerequisites || null,
            materialProvided: data.materialProvided || null,
            learningOutcomes: data.learningOutcomes,
            topics: finalTopicIds.map(id => ({
              id,
              name: "",
              createdAt: now,
              updatedAt: now
            })),
            topicIds: finalTopicIds,
            consultantProfileId: consultantId,
            consultantProfile: null,
            createdAt: initialData && this.isWebinarEvent(initialData) ? initialData.webinarPlan.createdAt : now,
            updatedAt: now,
          },
        };
        
        console.log("Saving webinar data:", webinarData);
        const savedWebinar = await this.saveWebinar(webinarData, consultantId);
        
        toast({
          title: "Success",
          description: `${initialData ? "Updated" : "Created"} webinar "${data.title}" successfully`,
        });
        
        return savedWebinar;
      } else {
        // For class events, access classContents with type casting
        const classData = data as any;
        const classContents = classData.classContents || [];
        
        const classEventData = {
          type: "class" as const,
          classPlan: {
            id: initialData && this.isClassEvent(initialData) ? initialData.classPlan.id : "",
            title: data.title,
            description: data.description,
            price: data.price,
            durationInMonths:
              "durationInMonths" in data ? data.durationInMonths : 0,
            maxParticipants: data.maxParticipants,
            language: data.language,
            level: data.level,
            prerequisites: data.prerequisites || null,
            materialProvided: data.materialProvided || null,
            learningOutcomes: data.learningOutcomes,
            topics: finalTopicIds.map(id => ({
              id,
              name: "",
              createdAt: now,
              updatedAt: now
            })),
            topicIds: finalTopicIds,
            consultantProfileId: consultantId,
            consultantProfile: null,
            certificateProvided:
              "certificateProvided" in data ? data.certificateProvided : false,
            callsPerWeek: "callsPerWeek" in data ? data.callsPerWeek : 0,
            videoMeetings: "videoMeetings" in data ? data.videoMeetings : 0,
            emailSupport:
              "emailSupport" in data ? data.emailSupport : "GENERAL",
            classContents: classContents.map((content: any, index: number) => ({
              id: content.id || `temp-${index}`,
              title: content.title,
              description: content.description,
              contentType: content.contentType || null,
              contentUrl: content.contentUrl || null,
              order: content.order,
              hoursAllotted: content.hoursAllotted,
              createdAt: now,
              updatedAt: now,
              classPlanId: initialData && this.isClassEvent(initialData) ? initialData.classPlan.id : "",
            })),
            createdAt: initialData && this.isClassEvent(initialData) ? initialData.classPlan.createdAt : now,
            updatedAt: now,
          },
        };
        
        console.log("Saving class data:", classEventData);
        try {
          const savedClass = await this.saveClass(classEventData, consultantId);
          
          toast({
            title: "Success",
            description: `${initialData ? "Updated" : "Created"} class "${data.title}" successfully`,
          });
          
          return savedClass;
        } catch (saveError) {
          console.error("Error in saveClass:", saveError);
          throw saveError;
        }
      }
    } catch (error) {
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
      
      throw error;
    }
  }
} 