/**
 * #appt-support — the channel-agnostic support core.
 *
 * A per-appointment support thread is driven by a `SupportResolver`. The SAME
 * interface is implemented three ways — a deterministic flowchart (now), an AI
 * agent (later), and a human hand-off — so a thread can move SELF_SERVE → AI →
 * HUMAN without changing the data model or the calling code. Every resolver is
 * handed the SAME `SupportContext` (appointment + money + recording facts), so a
 * hand-off never loses context — the failure mode the research flagged as the
 * #1 cause of customer frustration.
 */

import type {
  AppointmentsType,
  SupportChannel,
  SupportThreadCategory,
  SupportMessageSender,
} from "@prisma/client";

/** Immutable facts about the appointment, resolved once and passed to every
 *  resolver so none of them re-query or diverge. */
export interface SupportContext {
  threadId: string;
  appointmentId: string;
  userId: string;
  organizationId: string | null;
  appointmentType: AppointmentsType;
  /** True when the appointment is org-sponsored/hosted (drives B2B intents). */
  isOrgContext: boolean;
  /** True when the caller is the delivering side (expert/consultant). */
  isProvider: boolean;
  /** Soonest upcoming slot start, if any (drives reschedule/cancel windows). */
  startsAt: Date | null;
  /** Policy refund % were the user to cancel now (reuse computeRefundPct). */
  refundPctIfCancelledNow: number | null;
  paymentId: string | null;
  /** Captured payment amount in paise — lets the escalation policy size the
   *  refund exposure (amount × refundPct) rather than guess. */
  paymentAmountPaise: number | null;
  hasRecording: boolean;
}

/** One turn of a support conversation, resolver-agnostic. */
export interface SupportTurnInput {
  /** Free-text the user typed, or a chosen option id (flowchart choice). */
  userMessage?: string;
  chosenOptionId?: string;
}

/** A message a resolver wants appended to the thread. */
export interface SupportEmittedMessage {
  sender: SupportMessageSender;
  body: string;
  metadata?: Record<string, unknown>;
}

/** A resolver-requested side effect (validated + executed by the caller, never
 *  by the resolver itself — keeps money actions out of the flow/LLM). */
export type SupportAction =
  | { kind: "OFFER_CANCEL_REFUND"; refundPct: number }
  | { kind: "OFFER_RESCHEDULE" }
  | { kind: "SHOW_REFUND_STATUS" }
  | { kind: "SHOW_RECORDING_LINK" }
  | { kind: "COLLECT_FEEDBACK" }
  | { kind: "NONE" };

/** What a resolver returns for one turn. */
export interface SupportTurnResult {
  messages: SupportEmittedMessage[];
  /** The next flowchart node (SELF_SERVE), or null when the turn is terminal. */
  nextNodeId: string | null;
  /** Resolver-requested actions for the caller to validate + perform. */
  actions: SupportAction[];
  /** True → the caller must hand off to a human (create/link a SupportTicket). */
  escalate: boolean;
  /** True → the thread is resolved. */
  resolved: boolean;
}

/** The uniform contract every channel implements. */
export interface SupportResolver {
  readonly channel: SupportChannel;
  /**
   * Advance the conversation one turn. `currentNodeId` is the flowchart cursor
   * (null on the first turn / for non-flowchart channels).
   */
  resolveTurn(
    ctx: SupportContext,
    currentNodeId: string | null,
    input: SupportTurnInput,
  ): Promise<SupportTurnResult>;
}

// ---------------------------------------------------------------------------
// Flowchart (deterministic decision-tree) definitions — the SELF_SERVE channel.
// ---------------------------------------------------------------------------

/** A selectable branch out of a prompt node. */
export interface FlowOption {
  id: string;
  label: string;
  /** Next node to go to when chosen; null = terminal (with optional action). */
  next: string | null;
}

/** One node of a flowchart. A PROMPT asks the user to choose; a TERMINAL ends
 *  the flow (optionally requesting an action or escalation). */
export type FlowNode =
  | {
      id: string;
      kind: "PROMPT";
      /** Bot message shown at this node. */
      body: string;
      options: FlowOption[];
    }
  | {
      id: string;
      kind: "TERMINAL";
      body: string;
      action?: SupportAction;
      escalate?: boolean;
      resolved?: boolean;
    };

/** A named flowchart for one intent, with an entry node. Availability can be
 *  gated on context (e.g. B2B-only intents). */
export interface FlowDefinition {
  category: SupportThreadCategory;
  title: string;
  entryNodeId: string;
  nodes: Record<string, FlowNode>;
  /** Optional predicate — when present and false, the intent is not offered. */
  available?: (ctx: SupportContext) => boolean;
}
