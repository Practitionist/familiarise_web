import {
  TWebinar,
  TClass,
  TConsultation,
  TSubscription,
} from "@/types/appointment";
import { PlanEmailSupport } from "@prisma/client";
import { ConsultationPlan, SubscriptionPlan } from "@/schemas/plans";

// UI-focused event types with topics as string[] (transformed at service boundary)
// Services convert Topic[] from Prisma to string[] before passing to components

export type WebinarEvent = Omit<TWebinar, "webinarPlan"> & {
  type: "webinar";
  scheduledAt?: Date;
  webinarPlan: Omit<TWebinar["webinarPlan"], "topics"> & {
    topics: string[];
  };
};

export type ClassEvent = Omit<TClass, "classPlan"> & {
  type: "class";
  classPlan: Omit<TClass["classPlan"], "topics"> & {
    topics: string[];
  };
};

// Consultant profile summary type for plan events
type ConsultantProfileSummary = {
  id: string;
  userId: string;
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
    imageUrl: string | null;
  };
};

// Plan-level event types for consultation and subscription
export type ConsultationPlanEvent = {
  type: "consultation";
  id?: string;
  consultationPlan: ConsultationPlan & {
    id?: string;
    consultantProfileId: string;
    consultantProfile?: ConsultantProfileSummary | null;
    consultations?: TConsultation[];
    createdAt?: Date;
    updatedAt?: Date;
  };
};

export type SubscriptionPlanEvent = {
  type: "subscription";
  id?: string;
  subscriptionPlan: SubscriptionPlan & {
    id?: string;
    consultantProfileId: string;
    consultantProfile?: ConsultantProfileSummary | null;
    subscriptions?: TSubscription[];
    sessionDurationInHours?: number;
    createdAt?: Date;
    updatedAt?: Date;
  };
};

// Update base Event type to be a union
export type Event =
  | WebinarEvent
  | ClassEvent
  | ConsultationPlanEvent
  | SubscriptionPlanEvent;

export type EventPlannerProps = {
  isOpen: boolean;
  onClose: () => void;
  eventType: "webinar" | "class" | "consultation" | "subscription";
  initialData?: Event;
  onSave?: (
    event:
      | Partial<WebinarEvent>
      | Partial<ClassEvent>
      | Partial<ConsultationPlanEvent>
      | Partial<SubscriptionPlanEvent>,
  ) => void;
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
  meetingsPerWeek?: number;
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
      meetingsPerWeek: number;
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

export interface ConsultationPlannerProps extends BasePlannerProps {
  initialData?: ConsultationPlanEvent;
  onSave: (data: Partial<ConsultationPlanEvent>) => void | Promise<void>;
}

export interface SubscriptionPlannerProps extends BasePlannerProps {
  initialData?: SubscriptionPlanEvent;
  onSave: (data: Partial<SubscriptionPlanEvent>) => void | Promise<void>;
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
