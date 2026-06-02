/**
 * Dispute state-machine guard (#776).
 *
 * The gateway dispute webhook used to write `Dispute.status` unconditionally, so
 * a delayed/out-of-order delivery (or a manual resend) could record an illegal
 * transition — most importantly re-driving a TERMINAL dispute (WON/LOST/
 * CHARGE_REFUNDED), which re-runs the lost-dispute side effects (earnings→REFUNDED,
 * `applyOrgChargeback`). Money is already protected by ledger idempotency, but the
 * state model + audit trail are not. This guard keeps the machine honest.
 *
 * Transitions mirror Stripe/Razorpay dispute lifecycles: early-fraud WARNING_*
 * states can escalate into a real dispute (NEEDS_RESPONSE), which moves to
 * UNDER_REVIEW and then a terminal verdict. Terminal states are final.
 */
import type { DisputeStatus } from "@prisma/client";

/** Verdicts that must never transition again. */
export const TERMINAL_DISPUTE_STATUSES: DisputeStatus[] = [
  "WON",
  "LOST",
  "CHARGE_REFUNDED",
];

/** Allowed forward transitions. Same-status is handled separately (idempotent). */
const ALLOWED: Record<DisputeStatus, DisputeStatus[]> = {
  WARNING_NEEDS_RESPONSE: [
    "WARNING_UNDER_REVIEW",
    "WARNING_CLOSED",
    "NEEDS_RESPONSE",
  ],
  WARNING_UNDER_REVIEW: ["WARNING_CLOSED", "NEEDS_RESPONSE"],
  // A closed early-warning can still escalate into a formal dispute later.
  WARNING_CLOSED: ["NEEDS_RESPONSE"],
  NEEDS_RESPONSE: ["UNDER_REVIEW", "WON", "LOST", "CHARGE_REFUNDED"],
  UNDER_REVIEW: ["WON", "LOST", "CHARGE_REFUNDED"],
  // Terminal verdicts — no outgoing transitions.
  WON: [],
  LOST: [],
  CHARGE_REFUNDED: [],
};

/**
 * True when `from → to` is a legal dispute transition. Same-status returns true
 * (idempotent), but callers should short-circuit on equality to avoid re-running
 * resolution side effects on a webhook redelivery.
 */
export function isLegalDisputeTransition(
  from: DisputeStatus,
  to: DisputeStatus,
): boolean {
  if (from === to) return true;
  if (TERMINAL_DISPUTE_STATUSES.includes(from)) return false;
  return ALLOWED[from]?.includes(to) ?? false;
}
