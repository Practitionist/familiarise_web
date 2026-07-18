/**
 * #appt-support — escalation triggers: when a thread must move to a HUMAN
 * regardless of the resolver's own decision. Research (Zendesk/Fini) shows an
 * explicit, context-carrying hand-off is the make-or-break of bot support.
 *
 * Kept separate from the resolvers so all three channels share one policy, and
 * so a money threshold or keyword can be tuned without touching flow graphs.
 */

import type { SupportContext, SupportTurnResult } from "./types";

/** User phrases that always warrant a human, independent of the flow. */
const HUMAN_KEYWORDS = [
  "human",
  "agent",
  "representative",
  "speak to someone",
  "complaint",
  "legal",
  "chargeback",
  "fraud",
];

export interface EscalationDecision {
  escalate: boolean;
  reason?: string;
}

/**
 * Decide whether this turn should be escalated to a human. Combines:
 *   - the resolver's own `escalate` flag (a terminal escalate node),
 *   - explicit user keywords ("talk to a human", "complaint", …),
 *   - a high-value money trigger (large refund exposure warrants human review).
 */
export function decideEscalation(
  ctx: SupportContext,
  turn: SupportTurnResult,
  userMessage: string | undefined,
  opts: { highValueRefundPaise?: number } = {},
): EscalationDecision {
  if (turn.escalate) {
    return { escalate: true, reason: "flow_terminal" };
  }

  const text = (userMessage ?? "").toLowerCase();
  if (text && HUMAN_KEYWORDS.some((k) => text.includes(k))) {
    return { escalate: true, reason: "keyword" };
  }

  // A refund action above the review threshold goes to a human even if the flow
  // would auto-resolve — money over the line gets a person.
  const threshold = opts.highValueRefundPaise ?? 500_00; // ₹500 default
  const offersRefund = turn.actions.some(
    (a) => a.kind === "OFFER_CANCEL_REFUND" && a.refundPct > 0,
  );
  if (offersRefund && ctx.paymentId && threshold <= 0) {
    return { escalate: true, reason: "high_value_refund" };
  }

  return { escalate: false };
}
