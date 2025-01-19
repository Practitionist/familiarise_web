import { TConsultantProfile } from "@/types/consultant";

export interface IUser {
  id: string;
  name: string;
  email: string;
  image: string;
  currentTimezone: string;
}

export interface ISlotOfAppointment {
  id: string;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
  isTentative: boolean;
  user: IUser[];
}

export interface IBasePlan {
  id: string;
  title: string;
  description: string;
}

export interface IConsultationPlan extends IBasePlan {
  durationInHours: number;
}

export interface ISubscriptionPlan extends IBasePlan {
  durationInMonths: number;
  callsPerWeek: number;
}

export interface IWebinarPlan extends IBasePlan {
  durationInHours: number;
}

export interface IClassPlan extends IBasePlan {
  durationInMonths: number;
}

export interface IRequestedBy {
  user: {
    name: string;
    image: string;
  };
}

export interface IConsultation {
  id: string;
  consultationPlan: IConsultationPlan;
  requestStatus: string;
  requestedBy: IRequestedBy;
}

export interface ISubscription {
  id: string;
  subscriptionPlan: ISubscriptionPlan;
  requestStatus: string;
  requestedBy: IRequestedBy;
  startDate: string;
  endDate: string;
}

export interface IWebinar {
  id: string;
  webinarPlan: IWebinarPlan;
  status: string;
}

export interface IClass {
  id: string;
  classPlan: IClassPlan;
  status: string;
}

export interface IAppointment {
  id: string;
  appointmentType: 'CONSULTATION' | 'SUBSCRIPTION' | 'WEBINAR' | 'CLASS';
  slotsOfAppointment: ISlotOfAppointment[];
  consultation?: IConsultation;
  subscription?: ISubscription;
  webinar?: IWebinar;
  class?: IClass;
}

export interface IDocument {
  id: string;
  title: string;
  invoiceNo: string;
  clientName: string;
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
export interface HomeTabProps extends WithBadgeStyle {
  appointments: IAppointment[];
  activities: IActivity[];
  approvals: IApproval[];
  onUpdate?: () => void;
}

export interface AppointmentsTabProps extends WithBadgeStyle {
  appointments: IAppointment[];
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
export interface AppointmentCardProps extends IAppointment, WithBadgeStyle {}

export interface ClientActivityProps {
  activities: IActivity[];
}

// Utility type for badge styles
export type BadgeStyleMap = {
  [key: string]: string;
};

// Constants for badge styles
export const BADGE_STYLES: BadgeStyleMap = {
  Completed: "bg-gray-400 text-white",
  "Meeting in 5 min": "bg-red-500 text-white",
  "Meeting in 2 hours": "bg-blue-500 text-white",
  Tomorrow: "bg-purple-500 text-white",
  "In week": "bg-green-500 text-white",
  "In month": "bg-yellow-500 text-white",
  "In year": "bg-orange-500 text-white",
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
