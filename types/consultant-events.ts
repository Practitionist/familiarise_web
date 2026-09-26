import type { ConsultantNeedsYou } from "@/lib/data/consultant-needs-you";
import { TAppointment } from "@/types/appointment";

/**
 * Types for the consultant dashboard API response
 * Matches the API in /api/dashboard/consultant/[consultantId]/route.ts
 *
 * Naming convention: T prefix for types (e.g., TConsultantActivity)
 */

// Activity type for recent client activities
// Matches the API response from /api/dashboard/consultant/[consultantId]/route.ts
interface TConsultantActivity {
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

// Approval type for pending consultation/subscription requests
interface TConsultantApproval {
  id: string;
  name: string;
  type: string;
  date: string;
  time: string;
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

// Performance snapshot for consultant dashboard KPIs
export interface TPerformanceSnapshot {
  /** Earnings this month in paise (divide by 100 for INR) */
  earningsThisMonth: number;
  /** Earnings last month in paise (divide by 100 for INR) */
  earningsLastMonth: number;
  earningsTrend: number;
  /** Session completion rate (last 30 days). null when no data. */
  completionRate: number | null;
  averageRating: number;
  totalReviews: number;
  /** Trial conversion rate (last 90 days). null when no data. */
  trialConversionRate: number | null;
}

// Financial summary for consultant dashboard home
export interface TFinancialSummary {
  /** Net earnings in paise (divide by 100 for INR) */
  netEarnings: number;
  /** Next payout amount in paise (divide by 100 for INR) */
  nextPayout: number;
  payoutStatus: string;
  activeClients: number;
  activePrograms: number;
}

/** #1766 — an APPROVED subscription whose live cycle is done with entitlement left. */
export interface TConsultantNextCycle {
  subscriptionId: string;
  consulteeName: string;
  planTitle: string;
  nextBatch: number;
  held: number;
  total: number;
  windowStart: Date;
  windowEnd: Date;
  /** The existing allocate route for this request. */
  href: string;
}

// Full API response type for consultant dashboard
export interface TConsultantDashboardResponse {
  appointments: TAppointment[];
  activities: TConsultantActivity[];
  approvals: TConsultantApproval[];
  /** Total pending requests — `approvals` is a capped preview, so don't count it. */
  pendingRequestsCount: number;
  /** Approved-but-unpaid requests: total plus the newest three. #1703 */
  awaitingPayment: { count: number; items: TConsultantApproval[] };
  /** Next org-funded sessions to deliver, metadata only (ADR 20). #1703 */
  orgSessions: TConsultantOrgSession[];
  /** Subscriptions whose next cycle is waiting to be scheduled. #1766 */
  nextCycles: TConsultantNextCycle[];
  /** Share of requests answered within a day over the last 30 days. #1703 */
  responseRate: {
    withinTarget: number;
    total: number;
    withinTargetPct: number | null;
  };
  performanceSnapshot: TPerformanceSnapshot;
  financialSummary: TFinancialSummary;
  /** #1675 PR-Y2 — earnings exist and the payout account is what stops them. */
  payoutSetup?: { needed: boolean; href: string; livePayoutsEnabled: boolean };
  /** #1527 — Home's Needs you strip; absent when its read failed. */
  needsYou?: ConsultantNeedsYou;
  /** #1527 — Home's This month card and milestone line. */
  sessionsDelivered?: { thisMonth: number; lifetime: number };
}
