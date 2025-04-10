import { TWebinar, TClass } from "@/types/appointment";
import { PlanEmailSupport } from "@prisma/client";

// Define the final event types, intersecting with the literal type
export type WebinarEvent = TWebinar & { type: "webinar" };
export type ClassEvent = TClass & { type: "class" };

// Update base Event type to be a union
export type Event = WebinarEvent | ClassEvent;

export type EventPlannerProps = {
  isOpen: boolean;
  onClose: () => void;
  eventType: "webinar" | "class";
  initialData?: Event;
  onSave?: (event: Partial<WebinarEvent> | Partial<ClassEvent>) => void;
  isSaving?: boolean;
};

export type FormData = {
  title: string;
  description: string;
  price: number;
  maxParticipants: number;
  language: string;
  level: string;
  prerequisites: string | null;
  materialProvided: string | null;
  learningOutcomes: string[];
  topics: string[];
  consultantProfileId?: string | null;
  durationInHours?: number;
  durationInMonths?: number;
  callsPerWeek?: number;
  videoMeetings?: number;
  emailSupport?: PlanEmailSupport;
  certificateProvided?: boolean;
  classContents?: ClassContentInput[];
  scheduledAt?: string | Date | null;
  priceCurrency?: string;
} & (
  | {
      durationInHours: number;
    }
  | {
      durationInMonths: number;
      callsPerWeek: number;
      videoMeetings: number;
      emailSupport: "GENERAL" | "PRIORITY" | "DEDICATED";
      certificateProvided: boolean;
      classContents: {
        id?: string;
        title: string;
        description: string;
        contentType?: string;
        contentUrl?: string;
        order: number;
        hoursAllotted: number;
      }[];
    }
);

export interface BasePlannerProps {
  isOpen: boolean;
  onClose: () => void;
  consultantId: string;
  isSaving?: boolean;
}

export interface WebinarPlannerProps extends BasePlannerProps {
  initialData?: WebinarEvent;
  onSave: (data: Partial<WebinarEvent>, scheduledAt?: string | Date) => void;
}

export interface ClassPlannerProps extends BasePlannerProps {
  initialData?: ClassEvent;
  onSave: (data: Partial<ClassEvent>) => void;
}

// Define input type for ClassContent based on usage
export type ClassContentInput = {
  id?: string; // Optional for new content
  title: string;
  description: string;
  contentType?: string | null;
  contentUrl?: string | null;
  order: number;
  hoursAllotted: number;
};
