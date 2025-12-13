import { TConsultantProfile } from "@/types/consultant";
import { TAppointment } from "@/types/appointment";

export interface IDocument {
  id: string;
  appointmentId: string;
  fileName: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  description: string | null;
  reviewStatus:
    | "PENDING"
    | "IN_REVIEW"
    | "APPROVED"
    | "REJECTED"
    | "NEEDS_REVISION";
  reviewNotes: string | null;
  reviewedAt: Date | null;
  uploadedAt: Date;
  clientName: string;
  clientId: string;
  appointmentTitle: string;
  appointmentType: string;
  // Legacy fields for existing UI compatibility
  title: string;
  invoiceNo: string;
  tag: string;
}

export interface IActivity {
  id: string;
  name: string;
  action: string;
  time: string;
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

export interface AppointmentsTabProps {
  appointments: TAppointment[];
  badgeStyles: BadgeStyleMap;
  onUpdate?: () => void;
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
  "Meeting in 5 min": "bg-red-500 text-white",
  "Meeting in 2 hours": "bg-blue-500 text-white",
  Today: "bg-blue-600 text-white",
  Tomorrow: "bg-purple-500 text-white",
  "In week": "bg-green-500 text-white",
  "In month": "bg-yellow-500 text-white",
  "In year": "bg-orange-500 text-white",
  "Not Scheduled": "bg-orange-600 text-white",
  default: "bg-gray-500 text-white",
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
