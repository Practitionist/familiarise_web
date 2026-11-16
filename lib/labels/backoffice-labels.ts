import type {
  DisputeStatus,
  OpsActionProposalStatus,
  OrgInvoiceStatus,
  OrgStatus,
  SupportPriority,
  SupportCaseStatus,
  SystemJobStatus,
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

// Customer waiting is tracked by the case clock, independently of its status.
export const TICKET_STATUS: Record<SupportCaseStatus, ToneLabel> = {
  OPEN: { label: "Open", tone: "warning" },
  IN_PROGRESS: { label: "In progress", tone: "info" },
  ESCALATED: { label: "Escalated", tone: "critical" },
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

export const caseStatus = (v: string | null | undefined) =>
  resolve(TICKET_STATUS, v);

export const ORG_STATUS: Record<OrgStatus, ToneLabel> = {
  PENDING_VERIFICATION: { label: "Pending verification", tone: "warning" },
  ACTIVE: { label: "Active", tone: "success" },
  SUSPENDED: { label: "Suspended", tone: "critical" },
  DEACTIVATED: { label: "Deactivated", tone: "neutral" },
};
export const orgStatus = (v: string | null | undefined) =>
  resolve(ORG_STATUS, v);

/** The subscription list's derived plan state, as the route sends it (lower case). */
export const SUBSCRIPTION_DISPLAY_STATUS: Record<
  "active" | "expiring_soon" | "expired" | "cancelled",
  ToneLabel
> = {
  active: { label: "Active", tone: "success" },
  expiring_soon: { label: "Expiring soon", tone: "warning" },
  expired: { label: "Expired", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
export const subscriptionDisplayStatus = (v: string | null | undefined) =>
  resolve(SUBSCRIPTION_DISPLAY_STATUS, v?.toLowerCase());

export const ORG_INVOICE_STATUS: Record<OrgInvoiceStatus, ToneLabel> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  ISSUED: { label: "Issued", tone: "info" },
  PAID: { label: "Paid", tone: "success" },
  OVERDUE: { label: "Overdue", tone: "critical" },
  VOID: { label: "Void", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  REFUNDED: { label: "Refunded", tone: "neutral" },
};
export const orgInvoiceStatus = (v: string | null | undefined) =>
  resolve(ORG_INVOICE_STATUS, v);

/** A consumer tax invoice is issued, or reversed by a credit note. */
export const CONSUMER_INVOICE_STATUS: Record<
  "ISSUED" | "CREDIT_NOTED",
  ToneLabel
> = {
  ISSUED: { label: "Issued", tone: "info" },
  CREDIT_NOTED: { label: "Credit note issued", tone: "caution" },
};
export const consumerInvoiceStatus = (v: string | null | undefined) =>
  resolve(CONSUMER_INVOICE_STATUS, v);

export const PROPOSAL_STATUS: Record<OpsActionProposalStatus, ToneLabel> = {
  PROPOSED: { label: "Waiting for a second admin", tone: "warning" },
  APPROVED: { label: "Approved", tone: "info" },
  EXECUTED: { label: "Approved and run", tone: "success" },
  REJECTED: { label: "Rejected", tone: "neutral" },
  EXPIRED: { label: "Expired", tone: "neutral" },
};
export const proposalStatus = (v: string | null | undefined) =>
  resolve(PROPOSAL_STATUS, v);

/** Where a declared incident's settle run stands. */
export type IncidentPhase = "VOIDING" | "REMEDYING" | "SETTLED";
export const INCIDENT_PHASE: Record<IncidentPhase, ToneLabel> = {
  VOIDING: { label: "Voiding sessions", tone: "warning" },
  REMEDYING: { label: "Remedies in progress", tone: "info" },
  SETTLED: { label: "Settled", tone: "success" },
};
export function incidentPhase(i: {
  settledAt: string | null;
  enumeratedAt: string | null;
}): ToneLabel {
  if (i.settledAt) return INCIDENT_PHASE.SETTLED;
  return i.enumeratedAt ? INCIDENT_PHASE.REMEDYING : INCIDENT_PHASE.VOIDING;
}

export const RECONCILE_JOB_STATUS: Record<SystemJobStatus, ToneLabel> = {
  RUNNING: { label: "Running", tone: "info" },
  COMPLETED: { label: "Completed", tone: "success" },
  FAILED: { label: "Failed", tone: "critical" },
  CANCELLED: { label: "Stood down", tone: "neutral" },
};
export const reconcileJobStatus = (v: string | null | undefined) =>
  resolve(RECONCILE_JOB_STATUS, v);
