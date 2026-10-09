/**
 * #appt-support — escalation triggers: when a thread must move to a HUMAN
 * regardless of the resolver's own decision. Research (Zendesk/Fini) shows an
 * explicit, context-carrying hand-off is the make-or-break of bot support.
 *
 * Kept separate from the resolvers so all three channels share one policy, and
 * so a money threshold or keyword can be tuned without touching flow graphs.
 */

import type { SupportContext, SupportTurnResult } from "./types";

/** Word-bounded human/legal escalation triggers so substrings never false-match. */
const HUMAN_KEYWORD_RE =
  /\b(human|agent|representative|complaint|legal|chargeback|fraud)\b|speak to someone/i;

const BARE_HUMAN_PHRASE_RE =
  /\b(human|agent|representative)\b|speak to someone|talk to a person/i;

const BARE_STRIP_RE =
  /\b(i\s+(?:want|need|would\s+like)\s+(?:to\s+)?)?(?:talk|speak|chat)\s+(?:to|with)\s+(?:a\s+|an\s+|live\s+|real\s+)?(?:human|agent|representative|support|person|someone)\b|\b(?:human|agent|representative|support|person|someone|please|now|help|me|can|i|to|with|a|an)\b/gi;

/**
 * Does this message ask for a person? Exported so BOTH scopes can honour it —
 * the appointment thread reads it through `decideEscalation`, and the platform
 * intake calls it directly. Without that the unrecognized-input nudge, which
 * tells the user to type "agent", was a promise the platform drawer could not
 * keep: there is no thread there, so nothing was checking.
 */
export function mentionsHumanKeyword(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  return !!t && HUMAN_KEYWORD_RE.test(t);
}

/** True when the message asks for a person without stating the problem yet. */
export function isBareHumanRequest(msg: string): boolean {
  const trimmed = msg.trim();
  if (!trimmed || !BARE_HUMAN_PHRASE_RE.test(trimmed)) return false;
  const remaining = trimmed
    .replace(BARE_STRIP_RE, " ")
    .replace(/[^a-z0-9\s]/gi, " ")
    .trim();
  const contentWords = remaining ? remaining.split(/\s+/).filter(Boolean) : [];
  return contentWords.length < 3;
}

export interface EscalationBriefInput {
  customerAsk?: string | null;
  path?: string | null;
  botSaid?: string | null;
  reason?: string | null;
  topic?: string | null;
}

/** Structured handoff brief written to ticket descriptions at escalation time. */
export function escalationBrief(input: EscalationBriefInput): string {
  const lines: string[] = [];
  if (input.customerAsk?.trim()) {
    lines.push(`Customer ask: ${input.customerAsk.trim()}`);
  }
  if (input.topic?.trim()) {
    lines.push(`Topic: ${input.topic.trim()}`);
  }
  if (input.path?.trim()) {
    lines.push(`Flow path: ${input.path.trim()}`);
  }
  if (input.botSaid?.trim()) {
    lines.push(`Bot response: ${input.botSaid.trim()}`);
  }
  if (input.reason?.trim()) {
    lines.push(`Escalation reason: ${input.reason.trim()}`);
  }
  return lines.join("\n");
}

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

  if (mentionsHumanKeyword(userMessage)) {
    return { escalate: true, reason: "keyword" };
  }

  // A refund action above the review threshold goes to a human even if the flow
  // would auto-resolve — money over the line gets a person. Size the exposure
  // from the captured amount × the eligible %, not the % alone.
  const threshold = opts.highValueRefundPaise ?? 500_00; // ₹500 default
  const refundAction = turn.actions.find(
    (a) => a.kind === "OFFER_CANCEL_REFUND" && a.refundPct > 0,
  );
  if (refundAction?.kind === "OFFER_CANCEL_REFUND" && ctx.paymentAmountPaise) {
    const refundExposurePaise =
      (ctx.paymentAmountPaise * refundAction.refundPct) / 100;
    if (refundExposurePaise >= threshold) {
      return { escalate: true, reason: "high_value_refund" };
    }
  }

  return { escalate: false };
}
