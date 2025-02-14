import { TWebinar, TClass } from "@/types/appointment";

type ConsultantProfile = {
  user: {
    id: string;
    name: string | null;
    consultantProfileId: string | null;
    address: string | null;
    image: string | null;
    email: string | null;
    staffProfileId: string | null;
  };
};

export type WebinarEvent = {
  id: string;
  type: "webinar";
  webinarPlan: {
    id: string;
    title: string;
    description: string;
    price: number;
    durationInHours: number;
    maxParticipants: number;
    language: string;
    level: string;
    prerequisites: string | null;
    materialProvided: string | null;
    learningOutcomes: string[];
    topics: { id: string; name: string; createdAt: Date; updatedAt: Date }[];
    consultantProfileId: string | null;
    consultantProfile: ConsultantProfile | null;
    createdAt: Date;
    updatedAt: Date;
  };
  appointment: TWebinar["appointment"];
  waitlist: TWebinar["waitlist"];
  meetingRoom: TWebinar["meetingRoom"];
};

export type ClassEvent = {
  id: string;
  type: "class";
  classPlan: {
    id: string;
    title: string;
    description: string;
    price: number;
    certificateProvided: boolean;
    durationInMonths: number;
    callsPerWeek: number;
    videoMeetings: number;
    emailSupport: "GENERAL" | "PRIORITY" | "DEDICATED";
    maxParticipants: number;
    language: string;
    level: string;
    prerequisites: string | null;
    materialProvided: string | null;
    learningOutcomes: string[];
    topics: { id: string; name: string; createdAt: Date; updatedAt: Date }[];
    classContents: {
      id: string;
      title: string;
      description: string;
      contentType: string | null;
      contentUrl: string | null;
      order: number;
      hoursAllotted: number;
      createdAt: Date;
      updatedAt: Date;
      classPlanId: string;
    }[];
    consultantProfileId: string | null;
    consultantProfile: ConsultantProfile | null;
    createdAt: Date;
    updatedAt: Date;
  };
  appointments: TClass["appointments"];
  waitlist: TClass["waitlist"];
  meetingRoom: TClass["meetingRoom"];
};

export type Event = WebinarEvent | ClassEvent;

export interface WebinarPlannerProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (event: Partial<WebinarEvent>) => void;
  eventType: "webinar";
  initialData?: WebinarEvent | null;
  isSaving?: boolean;
}

export interface ClassPlannerProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (event: Partial<ClassEvent>) => void;
  eventType: "class";
  initialData?: ClassEvent | null;
  isSaving?: boolean;
}

export type EventPlannerProps = WebinarPlannerProps | ClassPlannerProps;

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
