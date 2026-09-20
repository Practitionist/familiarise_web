import { AppointmentStatus, OccurrenceCompletionStatus } from "@prisma/client";

// --- API Response Type Definitions ---

/** The page envelope both list routes return beside `data` (#1704). */
export interface ListMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

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
  completionStatus?: OccurrenceCompletionStatus;
}

/** A live reschedule proposal: the times the consultee actually wants. */
export interface RescheduleProposalInfo {
  id: string;
  status: string;
  reason?: string | null;
  round: number;
  expiresAt: string;
  initiatorRole: string;
  /** #1065 — stated instead of naming times; both may be absent. */
  preferredTimeOfDay?: "MORNING" | "AFTERNOON" | "EVENING" | null;
  preferredDays?: "WEEKDAYS" | "WEEKENDS" | null;
  proposedTimes: { startsAt: string; endsAt: string; round: number }[];
}

interface AppointmentInfo {
  id: string;
  occurrences?: AppointmentSlot[];
  rescheduleRequests?: RescheduleProposalInfo[];
}

export interface ConsultationApiResponse {
  id: string;
  consultationPlan?: ConsultationPlanInfo;
  requestedBy: RequestedBy;
  requestedAt: string;
  appointment?: AppointmentInfo;
  status: AppointmentStatus;
  bookingSource?: "DIRECT_CHECKOUT" | "REQUEST_SUBMITTED"; // Booking source enum
  /** What the consultee said when booking. */
  requestNotes?: string | null;
}

export interface SubscriptionApiResponse {
  id: string;
  subscriptionPlan?: SubscriptionPlanInfo;
  requestedBy: RequestedBy;
  requestedAt: string;
  /** The one wrapper (#1554); the list select is singular. */
  appointment?: AppointmentInfo;
  status: AppointmentStatus;
  bookingSource?: "DIRECT_CHECKOUT" | "REQUEST_SUBMITTED"; // Booking source enum
  // Correct field names from Prisma Subscription model
  schedulingPeriodStartsAt?: string;
  schedulingPeriodEndsAt?: string;
  /** Defines the limit day/week buckets (ADR B9); column default Asia/Kolkata. */
  schedulingTimezone?: string;
  /** #1766 — the entitlement frozen at purchase (null on pre-#1766 rows). */
  sessionsTotal?: number | null;
  /** What the consultee said when booking. */
  requestNotes?: string | null;
}
