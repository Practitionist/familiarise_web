import type {
  DisputeStatus,
  OrgStatus,
  SupportPriority,
  SupportThreadStatus,
  SupportTicketStatus,
} from "@prisma/client";

import { humanizeEnum, type Tone } from "@/lib/ui/tone";

/**
 * #1527 §15 — the back-office status maps, one per enum, as `{label, tone}`
 * for `StatusBadge`. Replaces the per-page colour switches that disagreed
 * (the staff home and the ticket queue coloured the same ticket differently).
 * Pure: server and client both import it.
 */

export interface ToneLabel {
  label: string;
  tone: Tone;
}

function resolve<K extends string>(
  map: Record<K, ToneLabel>,
  value: string | null | undefined,
): ToneLabel {
  return (
    map[value as K] ?? { label: humanizeEnum(value ?? ""), tone: "neutral" }
  );
}

// A ticket waiting on support is on "you"; on hold waits on the customer.
export const TICKET_STATUS: Record<SupportTicketStatus, ToneLabel> = {
  OPEN: { label: "Open", tone: "warning" },
  IN_PROGRESS: { label: "In progress", tone: "info" },
  ON_HOLD: { label: "On hold", tone: "caution" },
  RESOLVED: { label: "Resolved", tone: "success" },
  CLOSED: { label: "Closed", tone: "neutral" },
};
export const ticketStatus = (v: string | null | undefined) =>
  resolve(TICKET_STATUS, v);

export const TICKET_PRIORITY: Record<SupportPriority, ToneLabel> = {
  LOW: { label: "Low", tone: "neutral" },
  MEDIUM: { label: "Medium", tone: "info" },
  HIGH: { label: "High", tone: "warning" },
  URGENT: { label: "Urgent", tone: "critical" },
};
export const ticketPriority = (v: string | null | undefined) =>
  resolve(TICKET_PRIORITY, v);

export const DISPUTE_STATUS: Record<DisputeStatus, ToneLabel> = {
  WARNING_NEEDS_RESPONSE: { label: "Warning: respond", tone: "warning" },
  WARNING_UNDER_REVIEW: { label: "Warning in review", tone: "caution" },
  WARNING_CLOSED: { label: "Warning closed", tone: "neutral" },
  NEEDS_RESPONSE: { label: "Needs response", tone: "warning" },
  UNDER_REVIEW: { label: "Under review", tone: "caution" },
  CHARGE_REFUNDED: { label: "Charge refunded", tone: "neutral" },
  WON: { label: "Won", tone: "success" },
  LOST: { label: "Lost", tone: "critical" },
  CLOSED: { label: "Closed", tone: "neutral" },
};
export const disputeStatus = (v: string | null | undefined) =>
  resolve(DISPUTE_STATUS, v);

// Open/escalated wait on support; in progress is being worked.
export const THREAD_STATUS: Record<SupportThreadStatus, ToneLabel> = {
  OPEN: { label: "Open", tone: "warning" },
  IN_PROGRESS: { label: "In progress", tone: "info" },
  ESCALATED: { label: "Escalated", tone: "critical" },
  RESOLVED: { label: "Resolved", tone: "success" },
  CLOSED: { label: "Closed", tone: "neutral" },
};
export const threadStatus = (v: string | null | undefined) =>
  resolve(THREAD_STATUS, v);

export const ORG_STATUS: Record<OrgStatus, ToneLabel> = {
  PENDING_VERIFICATION: { label: "Pending verification", tone: "warning" },
  ACTIVE: { label: "Active", tone: "success" },
  SUSPENDED: { label: "Suspended", tone: "critical" },
  DEACTIVATED: { label: "Deactivated", tone: "neutral" },
};
export const orgStatus = (v: string | null | undefined) =>
  resolve(ORG_STATUS, v);
