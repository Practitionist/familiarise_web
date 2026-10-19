import type { PurchaseDisputeStatus } from "@prisma/client";

/**
 * The two-party adjudication protocol.
 *
 * A buyer claims a session was not delivered (or not as described). The
 * respondent — the consultant, or the host organisation — answers. The buyer
 * accepts or rejects that answer. An unreached or rejected answer escalates
 * to the platform, which rules.
 *
 * The protocol is deliberately NARROW: it says where the conversation is, not
 * where the money went. The money disposition lives on the case's own model
 * (`SupportCaseDecision` for the verdict, `SupportFinancialRecommendation`
 * for the refund), so a dispute can never disagree with the ledger about a
 * rupee. `PurchaseDispute` carries only the respondent, the round, the
 * answer, and the escalation.
 *
 * The one rule that is not obvious: `RESPONDED` means the respondent has
 * ANSWERED, not that the buyer has agreed. Which direction it went is
 * `respondentAcceptedRefund`:
 *   - accepted  → the platform executes the refund, then the dispute RESOLVES.
 *   - rejected  → the buyer may accept (no money moves, RESOLVED) or reject
 *                 (ESCALATED, the platform rules).
 */

/** The protocol is over. No further transition is legal. */
export const TERMINAL_DISPUTE_STATUSES: PurchaseDisputeStatus[] = [
  "RESOLVED",
  "WITHDRAWN",
  "CLOSED",
];

/**
 * The states that no longer gate anything: a resolved dispute does not hold
 * the booking's money, and a closed one never did.
 */
export const DISPUTE_INACTIVE_FOR_GATING: PurchaseDisputeStatus[] = [
  ...TERMINAL_DISPUTE_STATUSES,
];

/** The allowed forward transitions. Terminal states have none. */
const ALLOWED: Record<PurchaseDisputeStatus, PurchaseDisputeStatus[]> = {
  // The buyer has claimed; the respondent has not answered.
  OPEN: ["RESPONDED", "ESCALATED", "WITHDRAWN", "CLOSED"],
  // The respondent answered; the buyer has not accepted or rejected it.
  RESPONDED: ["ESCALATED", "RESOLVED", "WITHDRAWN", "CLOSED"],
  // The buyer rejected the answer, or the respondent missed the deadline.
  ESCALATED: ["UNDER_REVIEW", "RESOLVED", "CLOSED", "WITHDRAWN"],
  // The platform is adjudicating.
  UNDER_REVIEW: ["RESOLVED", "CLOSED", "WITHDRAWN"],
  RESOLVED: [],
  WITHDRAWN: [],
  CLOSED: [],
};

export function isTerminalDisputeStatus(
  status: PurchaseDisputeStatus,
): boolean {
  return TERMINAL_DISPUTE_STATUSES.includes(status);
}

export function isLegalDisputeTransition(
  from: PurchaseDisputeStatus,
  to: PurchaseDisputeStatus,
): boolean {
  // A same-status move is NOT legal. It looks like a no-op, but the actions
  // that carry content (the respondent's answer, the buyer's decision)
  // would silently OVERWRITE the first one — a second answer replacing the
  // answer the buyer is reading. The idempotent replay is handled separately,
  // by the action log, before the legality check is reached.
  if (from === to) return false;
  return (ALLOWED[from] ?? []).includes(to);
}

export class DisputeTransitionError extends Error {
  constructor(
    readonly from: PurchaseDisputeStatus,
    readonly to: PurchaseDisputeStatus,
  ) {
    super(`A dispute cannot move from ${from} to ${to}.`);
    this.name = "DisputeTransitionError";
  }
}

export function assertLegalDisputeTransition(
  from: PurchaseDisputeStatus,
  to: PurchaseDisputeStatus,
): void {
  if (!isLegalDisputeTransition(from, to)) {
    throw new DisputeTransitionError(from, to);
  }
}

/**
 * The buyer-facing wording. The reference product's phrasing ("Waiting for
 * platform's response") is the one users already recognise, so the platform
 * states plainly whose move it is.
 */
export const DISPUTE_STATUS_LABEL: Record<PurchaseDisputeStatus, string> = {
  OPEN: "Waiting for the expert to respond",
  RESPONDED: "Waiting for your reply",
  ESCALATED: "Escalated — waiting for the platform's decision",
  UNDER_REVIEW: "Under review by the platform",
  RESOLVED: "Resolved",
  WITHDRAWN: "Withdrawn",
  CLOSED: "Closed",
};

/** The staff-facing wording, which says who owns the next move. */
export const DISPUTE_STATUS_OWNER: Record<PurchaseDisputeStatus, string> = {
  OPEN: "Respondent",
  RESPONDED: "Buyer",
  ESCALATED: "Platform",
  UNDER_REVIEW: "Platform",
  RESOLVED: "—",
  WITHDRAWN: "—",
  CLOSED: "—",
};

/** The buyer-facing reason wording, one per ground a claim can be filed on. */
export const DISPUTE_REASON_LABEL: Record<string, string> = {
  NOT_DELIVERED: "The session was not held",
  SERVICE_NOT_AS_DESCRIBED: "The service was not as described",
  NO_SHOW: "The expert did not join",
  SESSION_ENDED_EARLY: "The session ended early",
  WRONG_CONSULTANT: "This is the wrong expert",
  DUPLICATE_CHARGE: "I was charged twice",
  REFUND_NOT_RECEIVED: "A refund I was promised never arrived",
  UNAUTHORISED: "I did not authorise this payment",
  OTHER: "Something else",
};
