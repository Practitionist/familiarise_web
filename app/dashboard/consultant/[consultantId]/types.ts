import { TConsultantProfile } from "@/types/consultant";
import { TAppointment } from "@/types/appointment";

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

// Props for each tab component
export interface HomeTabProps {
  appointments: TAppointment[];
  onUpdate?: () => void;
}

export interface UnscheduledClass {
  id: string;
  status: string;
  schedulingPeriodStartsAt: string | null;
  schedulingPeriodEndsAt: string | null;
  classPlan: {
    id: string;
    title: string;
    sessionsPerWeek: number;
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
export interface RequestsTabProps {
  approvals: IApproval[];
  onUpdate?: () => void;
}

/**
 * Pagination envelope returned by the consultant documents API (issue #346).
 * Defined here so both the fetch helper and the UI can import it.
 */

export interface ClientActivityProps {
  activities: IActivity[];
}

// Enum for section names
export enum DashboardSection {
  Home = "Home",
  Chats = "Chats",
  Appointments = "Appointments",
  Requests = "Requests",
  Trials = "Trials",
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
