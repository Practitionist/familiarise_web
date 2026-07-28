/**
 * #appt-support — SELF_SERVE resolver: walks a deterministic FlowDefinition.
 *
 * Pure + synchronous over the flow graph (no I/O), so it's cheap, testable, and
 * safe on a money-adjacent surface — it never performs an action itself, only
 * REQUESTS one (SupportAction) for the caller to validate and execute. AI/human
 * resolvers implement the same interface and drop in without touching callers.
 */

import type {
  SupportResolver,
  SupportContext,
  SupportTurnInput,
  SupportTurnResult,
  FlowDefinition,
} from "../types";

export class FlowchartResolver implements SupportResolver {
  readonly channel = "SELF_SERVE" as const;

  constructor(private readonly flow: FlowDefinition) {}

  async resolveTurn(
    ctx: SupportContext,
    currentNodeId: string | null,
    input: SupportTurnInput,
  ): Promise<SupportTurnResult> {
    // First turn — emit the entry node's prompt.
    const nodeId = currentNodeId ?? this.flow.entryNodeId;
    const node = this.flow.nodes[nodeId];
    if (!node) {
      // Unknown cursor — fail safe to a human rather than dead-end.
      return {
        messages: [
          {
            sender: "SYSTEM",
            body: "Let me connect you with our support team.",
          },
        ],
        nextNodeId: null,
        actions: [],
        escalate: true,
        resolved: false,
      };
    }

    // On the very first turn we just present the entry prompt.
    if (currentNodeId === null) {
      return this.present(node, ctx);
    }

    // Advancing: resolve the chosen option on the CURRENT node.
    if (node.kind === "PROMPT") {
      const chosen = node.options.find(
        (o) => o.id === input.chosenOptionId,
      );
      if (!chosen) {
        // Re-present the prompt on an unrecognized choice (idempotent).
        return this.present(node, ctx);
      }
      if (chosen.next === null) {
        // Choice ends the flow with no successor — treat as resolved.
        return {
          messages: [],
          nextNodeId: null,
          actions: [],
          escalate: false,
          resolved: true,
        };
      }
      const nextNode = this.flow.nodes[chosen.next];
      if (!nextNode) {
        return {
          messages: [
            { sender: "SYSTEM", body: "Connecting you with support." },
          ],
          nextNodeId: null,
          actions: [],
          escalate: true,
          resolved: false,
        };
      }
      return this.present(nextNode, ctx);
    }

    // Already at a terminal — nothing further to advance.
    return this.present(node, ctx);
  }

  /** Emit a node's message + (for terminals) its action/escalation. */
  private present(
    node: FlowDefinition["nodes"][string],
    ctx: SupportContext,
  ): SupportTurnResult {
    if (node.kind === "PROMPT") {
      return {
        messages: [
          {
            sender: "BOT",
            body: node.body,
            metadata: {
              nodeId: node.id,
              options: node.options.map((o) => ({ id: o.id, label: o.label })),
            },
          },
        ],
        nextNodeId: node.id,
        actions: [],
        escalate: false,
        resolved: false,
      };
    }
    // TERMINAL. A cancel-refund action carries only a placeholder refundPct in
    // the static flow graph — inject the context's actual eligible % so the
    // caller (and the escalation policy) sees the real refund exposure.
    const action =
      node.action?.kind === "OFFER_CANCEL_REFUND"
        ? { ...node.action, refundPct: ctx.refundPctIfCancelledNow ?? 0 }
        : node.action;
    return {
      messages: [{ sender: "BOT", body: node.body, metadata: { nodeId: node.id } }],
      nextNodeId: null,
      actions: action ? [action] : [],
      escalate: node.escalate ?? false,
      resolved: node.resolved ?? false,
    };
  }
}
