import { AppointmentStatus, SlotCompletionStatus } from "@prisma/client";

// --- API Response Type Definitions ---
interface UserInfo {
  id: string;
  name: string;
  image?: string;
}

export interface RequestedBy {
  id: string;
  user: UserInfo;
}

interface ConsultationPlanInfo {
  title?: string;
  durationInHours?: number;
}

interface SubscriptionPlanInfo {
  title?: string;
  sessionsPerWeek: number;
  durationInMonths: number;
  sessionDurationInHours: number;
  totalSessions?: number;
}

interface AppointmentSlot {
  id: string;
  startsAt: string;
  endsAt: string;
  isTentative?: boolean; // Indicates if slot needs rescheduling
  /** RESCHEDULED means startsAt is the time being moved AWAY from, not a request. */
  completionStatus?: SlotCompletionStatus;
}

interface AppointmentInfo {
  id: string;
  slotsOfAppointment?: AppointmentSlot[];
}

export interface ConsultationApiResponse {
  id: string;
  consultationPlan?: ConsultationPlanInfo;
  requestedBy: RequestedBy;
  requestedAt: string;
  appointment?: AppointmentInfo;
  status: AppointmentStatus;
  bookingSource?: "DIRECT_CHECKOUT" | "REQUEST_SUBMITTED"; // Booking source enum
}

export interface SubscriptionApiResponse {
  id: string;
  subscriptionPlan?: SubscriptionPlanInfo;
  requestedBy: RequestedBy;
  requestedAt: string;
  appointments?: AppointmentInfo[];
  status: AppointmentStatus;
  bookingSource?: "DIRECT_CHECKOUT" | "REQUEST_SUBMITTED"; // Booking source enum
  // Correct field names from Prisma Subscription model
  schedulingPeriodStartsAt?: string;
  schedulingPeriodEndsAt?: string;
  /** Defines the limit day/week buckets (ADR B9); column default Asia/Kolkata. */
  schedulingTimezone?: string;
}
