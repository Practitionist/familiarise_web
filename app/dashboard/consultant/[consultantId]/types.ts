import type React from "react";
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
  reviewedById?: string | null;
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

/**
 * Loading/error state for an auxiliary section fed by its own query
 * (trials / unscheduled classes / unscheduled webinars). Each section
 * renders its own skeleton and inline retry so one slow or failed query
 * can't blank the whole appointments page.
 */
export interface SectionQueryState {
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

export interface AppointmentsTabProps {
  appointments: TAppointment[];
  scheduledTrials?: ScheduledTrial[];
  trialsState?: SectionQueryState;
  consultantId?: string;
  onUpdate?: () => void;
  unscheduledClasses?: UnscheduledClass[];
  unscheduledClassesState?: SectionQueryState;
  unscheduledWebinars?: UnscheduledWebinar[];
  unscheduledWebinarsState?: SectionQueryState;
  /** Optional right-aligned element rendered next to the "All Appointments"
   *  header — used by the page wrapper to mount the OrgContextFilter
   *  dropdown inline instead of stacking it above the card. */
  headerSlot?: React.ReactNode;
}

export interface RequestsTabProps {
  approvals: IApproval[];
  onUpdate?: () => void;
}

/**
 * Pagination envelope returned by the consultant documents API (issue #346).
 * Defined here so both the fetch helper and the UI can import it.
 */
export interface DocumentsPagination {
  limit: number;
  offset: number;
  totalCount: number;
  totalPages: number;
  currentPage: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface DocumentsMetadata {
  pendingCount: number;
  reviewingCount: number;
  needsRevisionCount: number;
  completedCount: number;
}

export interface DocumentsPage {
  data: IDocument[];
  pagination: DocumentsPagination;
  metadata: DocumentsMetadata;
  count?: number;
  message?: string;
  consultant?: string;
  filters?: {
    status?: string | null;
    appointmentType?: string | null;
  };
}

export interface DocumentsTabProps {
  documentsPage: DocumentsPage | undefined;
  isPlaceholderData: boolean;

  // Pagination
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;

  // Filters (lifted up into the page component)
  statusFilter: string;
  typeFilter: string;
  onStatusFilterChange: (status: string) => void;
  onTypeFilterChange: (type: string) => void;
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

// Badge styles for the DERIVED timing statuses produced by
// getAppointmentStatus() ("Today", "Starting soon", "In 3 days", …).
// These are relative-proximity labels, not AppointmentStatus enum values,
// so they can't live in lib/labels/session-labels.ts — but they wear the
// same pill conventions (bg-*-100 text-*-900 border-*-200) so every badge
// across the dashboard reads as one system. Proximity ladder: red (now) →
// orange (imminent / needs action) → amber (today-ish) → emerald (soon) →
// zinc (far / terminal).
export const BADGE_STYLES: BadgeStyleMap = {
  Completed: "bg-green-100 text-green-900 border-green-200",
  Cancelled: "bg-zinc-100 text-zinc-600 border-zinc-200",
  "In Progress": "bg-blue-100 text-blue-900 border-blue-200",
  "Starting soon": "bg-orange-100 text-orange-900 border-orange-200",
  "Meeting in 5 min": "bg-red-100 text-red-900 border-red-200",
  Today: "bg-amber-100 text-amber-900 border-amber-200",
  Tomorrow: "bg-emerald-100 text-emerald-900 border-emerald-200",
  "In week": "bg-emerald-100 text-emerald-900 border-emerald-200",
  "In month": "bg-zinc-100 text-zinc-700 border-zinc-200",
  "In year": "bg-zinc-100 text-zinc-700 border-zinc-200",
  "Not Scheduled": "bg-orange-100 text-orange-900 border-orange-200",
  default: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

/**
 * Gets the badge style for a status string with pattern matching.
 * Handles dynamic statuses like "In 3 days", "In 2 weeks" that don't
 * have exact keys in BADGE_STYLES.
 */
export const getBadgeStyle = (status: string): string => {
  if (BADGE_STYLES[status]) return BADGE_STYLES[status];
  if (status.startsWith("In ") && status.includes("day"))
    return "bg-emerald-100 text-emerald-900 border-emerald-200";
  if (status.startsWith("In ") && status.includes("week"))
    return "bg-emerald-100 text-emerald-900 border-emerald-200";
  return BADGE_STYLES.default;
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
