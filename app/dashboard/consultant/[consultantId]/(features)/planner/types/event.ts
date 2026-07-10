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
  // price is number at runtime via the extended client (#780)
  webinarPlan: Omit<TWebinar["webinarPlan"], "topics" | "price"> & {
    topics: string[];
    price: number;
  };
};

export type ClassEvent = Omit<TClass, "classPlan"> & {
  type: "class";
  // price is number at runtime via the extended client (#780)
  classPlan: Omit<TClass["classPlan"], "topics" | "price"> & {
    topics: string[];
    price: number;
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
    // trialEnabled/trialDurationMinutes/trialPriceInPaise come from
    // SubscriptionPlanSchema
    subscriptionContents?: SubscriptionContentInput[];
    createdAt?: Date;
    updatedAt?: Date;
  };
};

// Planner-specific event types with role annotations
export type PlannerWebinarEvent = WebinarEvent & {
  collaboratorRole: string;
  isCollaborated: boolean;
};

export type PlannerClassEvent = ClassEvent & {
  collaboratorRole: string;
  isCollaborated: boolean;
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
  recordingEnabled?: boolean;
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

interface BasePlannerProps {
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
  onSave: (data: Partial<ClassEvent>, startDate?: string) => void;
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
  classPlanId?: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
};

// Define input type for SubscriptionContent (session roadmap)
type SubscriptionContentInput = {
  id?: string; // Optional for new content
  title: string;
  description: string;
  contentType?: string | null;
  contentUrl?: string | null;
  order: number;
  hoursAllotted: number;
  subscriptionPlanId?: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
};

// Form-to-Event input types - used when building event data from form submissions
// These are partial/input versions that don't require all Prisma fields

export type WebinarFormInput = {
  id?: string;
  webinarPlan: {
    id?: string;
    title: string;
    description?: string | null;
    price: number;
    priceCurrency: string;
    durationInHours: number;
    maxParticipants: number;
    certificateProvided: boolean;
    language?: string | null;
    level?: string | null;
    prerequisites?: string | null;
    materialProvided?: string | null;
    learningOutcomes: string[];
    topics: string[];
    consultantProfileId: string;
  };
};

export type ClassFormInput = {
  id?: string;
  classPlan: {
    id?: string;
    title: string;
    description?: string | null;
    price: number;
    priceCurrency: string;
    durationInMonths: number;
    meetingsPerWeek: number;
    maxParticipants: number;
    certificateProvided: boolean;
    recordingEnabled: boolean;
    emailSupport: string;
    language?: string | null;
    level?: string | null;
    prerequisites?: string | null;
    materialProvided?: string | null;
    learningOutcomes: string[];
    topics: string[];
    classContents: ClassContentInput[];
    consultantProfileId: string;
  };
};
