import { TConsultantProfile } from "@/types/consultant";
import { TAppointment } from "@/types/appointment";

export type DocumentUploadRole = "CONSULTEE" | "CONSULTANT";

export interface IDocument {
  id: string;
  appointmentId: string;
  fileName: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  storagePath?: string;
  description: string | null;
  reviewStatus:
    | "PENDING"
    | "IN_REVIEW"
    | "APPROVED"
    | "REJECTED"
    | "NEEDS_REVISION";
  reviewNotes: string | null;
  reviewedAt: Date | null;
  reviewedBy?: string | null;
  uploadedAt: Date;
  // Upload role - who uploaded this document
  uploadedByRole: DocumentUploadRole;
  // Response document linking
  responseToDocumentId?: string | null;
  responseToDocument?: {
    id: string;
    originalName: string;
    uploadedByRole: DocumentUploadRole;
  } | null;
  responseDocuments?: IDocument[];
  // Client/appointment context
  clientName: string;
  clientId: string;
  appointmentTitle: string;
  appointmentType: string;
  // Legacy fields for existing UI compatibility
  title: string;
  invoiceNo: string;
  tag: string;
}

export interface IPlanMaterial {
  id: string;
  fileName: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  storagePath: string;
  description: string | null;
  order: number;
  // Plan references (one will be set)
  consultationPlanId?: string | null;
  subscriptionPlanId?: string | null;
  webinarPlanId?: string | null;
  classPlanId?: string | null;
  uploadedAt: Date;
  updatedAt?: Date;
}

export interface IActivity {
  id: string;
  type: string;
  description: string;
  actorId: string;
  actorName: string;
  actorImage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  timeAgo: string;
}

export interface IApproval {
  id: string;
  name: string;
  type: string;
  date: string;
  time: string;
}

// Base props for components that need badge styling
export interface WithBadgeStyle {
  getBadgeStyle: (badge: string) => string;
}

// Props for each tab component
export interface HomeTabProps {
  appointments: TAppointment[];
  activities: IActivity[];
  approvals: IApproval[];
  badgeStyles: BadgeStyleMap;
  onUpdate?: () => void;
}

// Trial session type for appointments tab
export interface ScheduledTrial {
  id: string;
  status: string;
  notes: string | null;
  requestedAt: string;
  consulteeProfile: {
    id: string;
    user: {
      id: string;
      name: string;
      email: string;
      image: string | null;
    };
  };
  subscriptionPlan: {
    id: string;
    title: string;
    freeTrialDurationMinutes: number;
  };
  appointment: {
    id: string;
    slotsOfAppointment: Array<{
      id: string;
      startsAt: string;
      endsAt: string;
    }>;
  } | null;
}

export interface UnscheduledClass {
  id: string;
  status: string;
  schedulingPeriodStartsAt: string | null;
  schedulingPeriodEndsAt: string | null;
  classPlan: {
    id: string;
    title: string;
    meetingsPerWeek: number;
    sessionDurationInHours: number;
    totalSessions: number;
    consultantProfile?: {
      user?: {
        name: string;
        image: string | null;
      };
    };
  };
  appointments: unknown[];
}

export interface UnscheduledWebinar {
  id: string;
  status: string;
  webinarPlan: {
    id: string;
    title: string;
    durationInHours: number;
    consultantProfile?: {
      user?: {
        name: string;
        image: string | null;
      };
    };
  };
  appointment: null | undefined;
}

export interface AppointmentsTabProps {
  appointments: TAppointment[];
  badgeStyles: BadgeStyleMap;
  scheduledTrials?: ScheduledTrial[];
  consultantId?: string;
  onUpdate?: () => void;
  unscheduledClasses?: UnscheduledClass[];
  unscheduledWebinars?: UnscheduledWebinar[];
}

export interface RequestsTabProps {
  approvals: IApproval[];
  onUpdate?: () => void;
}

export interface DocumentsTabProps {
  documents: IDocument[];
}

// Props for reusable components
export interface AppointmentCardProps {
  appointment: TAppointment;
  badgeStyles: BadgeStyleMap;
}

export interface ClientActivityProps {
  activities: IActivity[];
}

// Utility type for badge styles
export type BadgeStyleMap = { [key: string]: string };

// Constants for badge styles
export const BADGE_STYLES: BadgeStyleMap = {
  Completed: "bg-gray-400 text-white",
  Cancelled: "bg-stone-400 text-white",
  "Meeting in 5 min": "bg-red-500 text-white",
  Today: "bg-blue-600 text-white",
  Tomorrow: "bg-purple-500 text-white",
  "In week": "bg-green-500 text-white",
  "In month": "bg-yellow-500 text-white",
  "In year": "bg-orange-500 text-white",
  "Not Scheduled": "bg-orange-600 text-white",
  default: "bg-gray-500 text-white",
};

/**
 * Gets the badge style for a status string with pattern matching.
 * Handles dynamic statuses like "In 3 days", "In 2 weeks" that don't
 * have exact keys in BADGE_STYLES.
 */
export const getBadgeStyle = (status: string): string => {
  if (BADGE_STYLES[status]) return BADGE_STYLES[status];
  if (status.startsWith("In ") && status.includes("day"))
    return "bg-green-500 text-white";
  if (status.startsWith("In ") && status.includes("week"))
    return "bg-green-500 text-white";
  return BADGE_STYLES.default;
};

// Constants for time calculations
export const TIME_CONSTANTS = {
  MINUTES_IN_HOUR: 60,
  HOURS_IN_DAY: 24,
  DAYS_IN_WEEK: 7,
  DAYS_IN_MONTH: 30.44, // Average days in a month
  DAYS_IN_YEAR: 365.25, // Account for leap years
};

// Enum for section names
export enum DashboardSection {
  Home = "Home",
  Chats = "Chats",
  Appointments = "Appointments",
  Requests = "Requests",
  Trials = "Free Trials",
  Documents = "Documents for Review",
  Help = "Help",
  Settings = "Settings",
}

// Type for API responses
export type ApiResponse<T> = {
  data: T;
  error?: string;
  message?: string;
  count?: number;
  consultant?: string;
  appointmentTitle?: string;
  consultantName?: string;
  filters?: {
    status?: string;
    appointmentType?: string;
  };
  metadata?: {
    pendingCount?: number;
    reviewingCount?: number;
    completedCount?: number;
  };
  meta?: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
};

// Type for sidebar props
export interface SidebarProps {
  activeSection: DashboardSection;
  setActiveSection: (section: DashboardSection) => void;
  consultant?: TConsultantProfile;
}
