import type { ConsultantNeedsYou } from "@/lib/data/consultant-needs-you";
import type { ActivationStep } from "@/lib/enterprise/org-activation";
import { TAppointment } from "@/types/appointment";

/**
 * Types for the consultant dashboard API response
 * Matches the API in /api/dashboard/consultant/[consultantId]/route.ts
 *
 * Naming convention: T prefix for types (e.g., TConsultantOrgSession)
 */

export interface TConsultantClientBooking {
  occurrenceId: string;
  appointmentId: string;
  startsAt: Date | string;
  endsAt: Date | string | null;
  expertName: string;
  /** The session on the consultant's learner dashboard; null without a learner profile. */
  href: string | null;
}

export interface TConsultantOrgSession {
  occurrenceId: string;
  appointmentId: string;
  organizationId: string;
  organizationName: string;
  startsAt: Date | string;
  endsAt: Date | string | null;
  isTentative: boolean;
  completionStatus: string | null;
  meeting: {
    id: string;
    endedAt: Date | string | null;
    endedReason: string | null;
  } | null;
}

/** The published ratings Home's This month card shows. */
export interface TPerformanceSnapshot {
  publishedRatingOneToOne: number | null;
  publishedRatingGroup: number | null;
  ratedClientsOneToOne: number;
  ratedEventsGroup: number;
}

/** Home shows the Earnings page's "Available" tile: READY + BATCHED, net of refunds, in paise. */
export interface TFinancialSummary {
  availableEarnings: number;
}

/** Exactly what the consultant Home renders; nothing else is read. */
export interface TConsultantDashboardResponse {
  appointments: TAppointment[];
  /** Next org-hosted sessions to deliver, metadata only. */
  orgSessions: TConsultantOrgSession[];
  /** Next sessions this consultant booked as a client; read-only busy time. */
  clientBookings?: TConsultantClientBooking[];
  /** Share of requests answered within a day over the last 30 days. */
  responseRate: {
    withinTarget: number;
    total: number;
    withinTargetPct: number | null;
  };
  performanceSnapshot: TPerformanceSnapshot;
  financialSummary: TFinancialSummary;
  /** Earnings exist and the payout account is what stops them. */
  payoutSetup?: { needed: boolean; href: string; livePayoutsEnabled: boolean };
  /** Home's Needs you strip, the requests count included; absent when its read failed. */
  needsYou?: ConsultantNeedsYou;
  /** Home's This month card and milestone line. */
  sessionsDelivered?: { thisMonth: number; lifetime: number };
  /** Home's setup checklist; absent once every step is done. */
  firstRun?: { steps: ActivationStep[] };
}
