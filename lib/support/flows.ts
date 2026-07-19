/**
 * #appt-support — the versioned, type-safe FLOW REGISTRY (SELF_SERVE channel).
 *
 * Each intent is a `FlowDefinition` in code (PR-reviewed, testable) — not DB
 * rows. `flowsForContext` returns the intents offered for a given appointment;
 * B2B-only intents (sponsorship, org-admin dispute) are gated via `available`.
 * This is the deterministic layer; an AI resolver later shares the SAME context
 * and can take over any thread.
 *
 * Started with the highest-frequency intents the research + domain surfaced.
 * The remaining categories (TECHNICAL, PAYMENT_STATUS, RECORDING_ACCESS,
 * QUALITY_COMPLAINT, ORG_ADMIN_DISPUTE) follow the identical shape.
 */

import type { FlowDefinition, SupportContext } from "./types";

// --- Cancel & refund (policy-driven; the refund % comes from context) --------
const cancelRefundFlow: FlowDefinition = {
  category: "CANCEL_REFUND",
  title: "Cancel or refund this session",
  entryNodeId: "start",
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "What would you like to do about this session?",
      options: [
        { id: "cancel", label: "Cancel and request a refund", next: "confirm" },
        { id: "keep", label: "Never mind, keep it", next: "kept" },
      ],
    },
    confirm: {
      id: "confirm",
      kind: "TERMINAL",
      // The concrete % is rendered by the caller from ctx.refundPctIfCancelledNow.
      body: "Here's the refund you're eligible for under the cancellation policy. Confirm to proceed.",
      action: { kind: "OFFER_CANCEL_REFUND", refundPct: 0 },
    },
    kept: {
      id: "kept",
      kind: "TERMINAL",
      body: "Great — your session is unchanged. Anything else?",
      resolved: true,
    },
  },
};

// --- Reschedule --------------------------------------------------------------
const rescheduleFlow: FlowDefinition = {
  category: "RESCHEDULE",
  title: "Reschedule this session",
  entryNodeId: "start",
  nodes: {
    start: {
      id: "start",
      kind: "TERMINAL",
      body: "You can pick a new time from the available slots.",
      action: { kind: "OFFER_RESCHEDULE" },
    },
  },
};

// --- Provider/expert no-show -------------------------------------------------
const noShowFlow: FlowDefinition = {
  category: "NO_SHOW",
  title: "The other participant didn't join",
  entryNodeId: "start",
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "Sorry about that. Did the session not happen because the other participant didn't join?",
      options: [
        { id: "yes", label: "Yes, they didn't join", next: "escalate" },
        { id: "tech", label: "No, we had technical problems", next: "tech" },
      ],
    },
    escalate: {
      id: "escalate",
      kind: "TERMINAL",
      body: "That qualifies for a review by our team, who can arrange a full refund or reschedule.",
      escalate: true,
    },
    tech: {
      id: "tech",
      kind: "TERMINAL",
      body: "Let's get you set up to try again, or reschedule.",
      action: { kind: "OFFER_RESCHEDULE" },
    },
  },
};

// --- B2B: sponsorship / who's paying (org-context only) ----------------------
const sponsorshipBillingFlow: FlowDefinition = {
  category: "SPONSORSHIP_BILLING",
  title: "Sponsorship & billing for this session",
  entryNodeId: "start",
  available: (ctx: SupportContext) => ctx.isOrgContext,
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "This session is sponsored by your organization. What do you need?",
      options: [
        { id: "who", label: "Who paid for this?", next: "who" },
        { id: "charged", label: "I think I was charged by mistake", next: "escalate" },
      ],
    },
    who: {
      id: "who",
      kind: "TERMINAL",
      body: "Your organization covered this session — you weren't charged personally.",
      resolved: true,
    },
    escalate: {
      id: "escalate",
      kind: "TERMINAL",
      body: "Let me connect you with support to check the charge.",
      escalate: true,
    },
  },
};

const ALL_FLOWS: FlowDefinition[] = [
  cancelRefundFlow,
  rescheduleFlow,
  noShowFlow,
  sponsorshipBillingFlow,
];

/** The intents offered for a given appointment (respects `available` gates). */
export function flowsForContext(ctx: SupportContext): FlowDefinition[] {
  return ALL_FLOWS.filter((f) => !f.available || f.available(ctx));
}

/** Look up a flow by category (or undefined if not offered for this context). */
export function flowForCategory(
  ctx: SupportContext,
  category: FlowDefinition["category"],
): FlowDefinition | undefined {
  return flowsForContext(ctx).find((f) => f.category === category);
}
