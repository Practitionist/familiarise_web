/**
 * #appt-support — the orchestrator that ties the channel-agnostic resolver core
 * to persistence. One entry point (`runSupportTurn`) drives a per-appointment
 * thread forward one turn: find-or-create the thread, build the shared context,
 * run the active channel's resolver, persist the exchange, advance the cursor,
 * and — on escalation — hand off to a HUMAN by linking the existing ops
 * SupportTicket queue (no parallel system).
 *
 * Money actions are only ever REQUESTED here (returned as `actions`); execution
 * is a separate, server-validated seam — a refund never fires from a flow graph.
 */

import prisma from "@/lib/prisma";
import type {
  SupportChannel,
  SupportThreadCategory,
} from "@prisma/client";
import { buildSupportContext } from "./context";
import { flowForCategory } from "./flows";
import { FlowchartResolver } from "./resolvers/flowchart-resolver";
import { decideEscalation } from "./escalation";
import { issueTypeForReason, priorityForReason } from "./priority";
import { notifySupportStaff } from "./create-ticket";
import type { SupportAction, SupportContext } from "./types";

export interface RunTurnInput {
  /** Chosen intent — set on the first turn (or to switch intents). */
  category?: SupportThreadCategory;
  /** A selected flowchart option id (SELF_SERVE advance). */
  chosenOptionId?: string;
  /** Free text the user typed. */
  userMessage?: string;
  /**
   * #support-hub — caller reached this appointment only via the org-operator
   * party branch. Their conversation is their own, but restricted to the
   * org-party intents; the route enforces this with a 403, this clamps
   * defensively so the invariant holds even if a future caller forgets.
   */
  isOrgParty?: boolean;
}

/** The only intents an org party may raise on a member's session. Shared with
 *  the route layer, which 403s on it — one definition so the two gates can
 *  never drift. */
export const ORG_PARTY_CATEGORIES: ReadonlySet<SupportThreadCategory> = new Set([
  "ORG_ADMIN_DISPUTE",
  "SPONSORSHIP_BILLING",
]);

export interface RunTurnResult {
  threadId: string;
  status: string;
  activeChannel: SupportChannel;
  currentNodeId: string | null;
  /** The bot/system messages produced this turn (already persisted). */
  messages: { sender: string; body: string; metadata?: unknown }[];
  /** Actions the resolver requested — the caller validates + executes them. */
  actions: SupportAction[];
  escalated: boolean;
  resolved: boolean;
  supportTicketId: string | null;
  /** Machine-readable escalation reason (terminal node / policy), if any. */
  reason?: string;
}

/** Advance a per-appointment support thread by one turn. The caller must have
 *  already verified the user participates in the appointment. Returns null if
 *  the appointment doesn't exist. */
export async function runSupportTurn(
  appointmentId: string,
  userId: string,
  input: RunTurnInput,
): Promise<RunTurnResult | null> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { organizationId: true },
  });
  if (!appt) return null;

  // Find-or-create — the @@unique([appointmentId, userId]) makes this the single
  // conversation for this order, and guards against a double-open race.
  const thread = await prisma.appointmentSupportThread.upsert({
    where: { appointmentId_userId: { appointmentId, userId } },
    create: {
      appointmentId,
      userId,
      organizationId: appt.organizationId,
      category: input.category ?? "OTHER",
    },
    update: {},
  });

  const ctx = await buildSupportContext(thread.id, appointmentId, userId);
  if (!ctx) return null;

  // Switching intent restarts the flow at its entry node.
  let category = thread.category;
  let currentNodeId = thread.currentNodeId;
  // Clicking an intent chip always (re)starts that intent's flow — a same-
  // category re-click must not resume a stale cursor, or the turn looks
  // ignored (the pre-#support-hub flows left threads whose option ids no
  // longer exist in the registry).
  if (input.category) {
    category = input.category;
    currentNodeId = null;
  }
  // Defensive clamp (route already 403s): an org party stays on org-party
  // intents no matter what reaches the service.
  if (input.isOrgParty && !ORG_PARTY_CATEGORIES.has(category)) {
    category = "ORG_ADMIN_DISPUTE";
    currentNodeId = null;
  }

  // Already with a human — persist the user's message and leave it in the queue.
  if (thread.activeChannel === "HUMAN") {
    return persistHumanTurn(thread.id, thread.supportTicketId, input.userMessage);
  }

  const flow = flowForCategory(ctx, category);
  // No self-serve flow for this intent (OTHER, not-yet-built categories) → human.
  if (!flow) {
    return escalate(ctx, thread.id, thread.supportTicketId, category, {
      messages: [
        { sender: "SYSTEM", body: "Connecting you with our support team." },
      ],
      nextNodeId: null,
      actions: [],
      resolved: false,
      escalate: true,
    }, input.userMessage, "no_flow");
  }

  // Flow-version drift: a persisted cursor from an older registry revision
  // (renamed/removed node) would make every choice mismatch and re-present
  // forever. Restart at the entry instead — the walker then presents the
  // CURRENT flow's first prompt and the thread is self-healing.
  if (currentNodeId && !flow.nodes[currentNodeId]) {
    currentNodeId = null;
  }

  const resolver = new FlowchartResolver(flow);
  const turn = await resolver.resolveTurn(ctx, currentNodeId, {
    chosenOptionId: input.chosenOptionId,
    userMessage: input.userMessage,
  });

  // Server truth for the recording processing window: the flow's within/beyond
  // 48h branch is client-claimed, so verify it against the slot's actual end.
  // Claiming "within" after the window has really expired is re-anchored onto
  // the flow's escalation terminal; the reverse (claiming "beyond" early) is
  // left alone — wanting a human is never wrong.
  //
  // Gated on the RESOLVED NODE, not the category. `within` is the only
  // resolved terminal that makes an elapsed-time claim. The playback branch's
  // `fixed` terminal ("Yes, it plays now") is also resolved, and recordings
  // only exist after processing — so most playback turns happen more than 48h
  // after the session ended. Gating on the category alone discarded the user's
  // confirmation that the problem was GONE, told them "our team will chase the
  // processing", and filed a false recording_missing ticket.
  const resolvedNodeId = (
    turn.messages[0]?.metadata as { nodeId?: string } | undefined
  )?.nodeId;
  if (
    category === "RECORDING_ACCESS" &&
    turn.resolved &&
    resolvedNodeId === "within" &&
    ctx.endsAt &&
    Date.now() - ctx.endsAt.getTime() > 48 * 3_600_000
  ) {
    // Target `beyond` by name rather than "the first escalating terminal in
    // object order" — that happened to pick `beyond` only because it is
    // declared before `broken`, so reordering the nodes would silently start
    // filing recording_broken for a missing recording.
    const beyond = flow.nodes["beyond"];
    const terminal =
      beyond?.kind === "TERMINAL" && beyond.escalate ? beyond : undefined;
    if (terminal) {
      return escalate(
        ctx,
        thread.id,
        thread.supportTicketId,
        category,
        {
          messages: [
            {
              sender: "BOT",
              body: terminal.body,
              metadata: { nodeId: terminal.id },
            },
          ],
          nextNodeId: null,
          actions: [],
          escalate: true,
          resolved: false,
        },
        input.userMessage,
        terminal.reason ?? "recording_missing",
      );
    }
  }

  const decision = decideEscalation(ctx, turn, input.userMessage);
  if (decision.escalate) {
    return escalate(
      ctx,
      thread.id,
      thread.supportTicketId,
      category,
      turn,
      input.userMessage,
      decision.reason ?? "escalated",
    );
  }

  // Ordinary self-serve turn — persist + advance the cursor.
  //
  // A re-present (unrecognized choice / double-submit: cursor didn't move) is
  // NOT persisted again when the current tail already IS that prompt — one
  // press must never append two identical bubbles. The caller still gets the
  // messages so the UI converges on the server state.
  const isRepresent =
    !!currentNodeId && turn.nextNodeId === currentNodeId;
  const status = turn.resolved ? "RESOLVED" : "IN_PROGRESS";
  // A free-text message is user activity even on a re-present turn (the
  // duplicate-suppression only covers the BOT's re-rendered prompt).
  const wroteMessages =
    !!input.userMessage || (turn.messages.length > 0 && !isRepresent);
  await prisma.$transaction(async (tx) => {
    if (input.userMessage) {
      await tx.supportMessage.create({
        data: { threadId: thread.id, sender: "USER", body: input.userMessage },
      });
    }
    if (!isRepresent) {
      for (const m of turn.messages) {
        await tx.supportMessage.create({
          data: {
            threadId: thread.id,
            sender: m.sender,
            body: m.body,
            metadata: (m.metadata as object) ?? undefined,
          },
        });
      }
    }
    await tx.appointmentSupportThread.update({
      where: { id: thread.id },
      data: {
        category,
        currentNodeId: turn.nextNodeId,
        status,
        resolvedAt: turn.resolved ? new Date() : null,
        // Keep the hub's "latest activity first" clock honest — updatedAt
        // alone won't move on message inserts.
        ...(wroteMessages ? { lastMessageAt: new Date() } : {}),
      },
    });
  });

  return {
    threadId: thread.id,
    status,
    activeChannel: "SELF_SERVE",
    currentNodeId: turn.nextNodeId,
    messages: turn.messages,
    actions: turn.actions,
    escalated: false,
    resolved: turn.resolved,
    supportTicketId: thread.supportTicketId,
    reason: turn.reason,
  };
}

/** Persist a message on a thread already handed to a human. */
async function persistHumanTurn(
  threadId: string,
  supportTicketId: string | null,
  userMessage: string | undefined,
): Promise<RunTurnResult> {
  if (userMessage) {
    await prisma.$transaction([
      prisma.supportMessage.create({
        data: { threadId, sender: "USER", body: userMessage },
      }),
      prisma.appointmentSupportThread.update({
        where: { id: threadId },
        data: { lastMessageAt: new Date() },
      }),
    ]);
  }
  return {
    threadId,
    status: "ESCALATED",
    activeChannel: "HUMAN",
    currentNodeId: null,
    messages: [],
    actions: [],
    escalated: true,
    resolved: false,
    supportTicketId,
  };
}

/** Hand the thread to a human: persist the exchange, create/link a SupportTicket
 *  in the existing ops queue, and flip the channel to HUMAN. */
async function escalate(
  ctx: SupportContext,
  threadId: string,
  existingTicketId: string | null,
  category: SupportThreadCategory,
  turn: {
    messages: { sender: string; body: string; metadata?: Record<string, unknown> }[];
    nextNodeId: string | null;
    actions: SupportAction[];
    resolved: boolean;
    escalate: boolean;
    reason?: string;
  },
  userMessage: string | undefined,
  reason: string,
): Promise<RunTurnResult> {
  // Terminal-node reasons win (they're the specific why); policy reasons
  // (high_value_refund, no_flow) fill in. Priority comes from the shared map.
  const effectiveReason = turn.reason ?? reason;
  const priority = priorityForReason(effectiveReason);
  const issueType = issueTypeForReason(effectiveReason);

  // Staff notification must fire only for a ticket that actually committed, so
  // the transaction reports back whether it minted one and the notify happens
  // after. (This is also why the create below cannot just call
  // `createSupportTicket` — that helper is not transaction-aware.)
  let createdTicket: { id: string; title: string; organizationId: string | null } | null =
    null;

  const ticketId = await prisma.$transaction(async (tx) => {
    if (userMessage) {
      await tx.supportMessage.create({
        data: { threadId, sender: "USER", body: userMessage },
      });
    }
    for (const m of turn.messages) {
      await tx.supportMessage.create({
        data: {
          threadId,
          sender: m.sender as "BOT" | "SYSTEM" | "USER" | "AGENT",
          body: m.body,
          metadata: (m.metadata as object) ?? undefined,
        },
      });
    }

    let linkedTicketId = existingTicketId;
    if (!linkedTicketId) {
      const ticket = await tx.supportTicket.create({
        data: {
          userId: ctx.userId,
          title: `Support for appointment ${ctx.appointmentId}`,
          description: `Escalated from per-appointment support (${category}, reason: ${effectiveReason}).`,
          priority,
          category,
          // The machine-readable half of the terminal reason. Without it every
          // session escalation reached ops as an untyped row and none of the
          // session-scoped issue types was reachable anywhere in the product.
          issueType: issueType ?? undefined,
          paymentId: ctx.paymentId,
          // Org attribution for the ops queue's org filter (null = B2C).
          organizationId: ctx.organizationId,
        },
        select: { id: true, title: true, organizationId: true },
      });
      linkedTicketId = ticket.id;
      createdTicket = ticket;
    }

    await tx.appointmentSupportThread.update({
      where: { id: threadId },
      data: {
        category,
        currentNodeId: null,
        status: "ESCALATED",
        activeChannel: "HUMAN",
        supportTicketId: linkedTicketId,
        lastMessageAt: new Date(),
      },
    });
    return linkedTicketId;
  });

  // Committed — now it is safe to page the queue. Fire-and-forget for the same
  // reason the factory does it: a notification failure must not turn a
  // successful escalation into a 500 and have the user retry into a duplicate.
  if (createdTicket) {
    await notifySupportStaff(createdTicket).catch((error) => {
      console.error("support: staff notification failed for escalation", {
        ticketId: (createdTicket as { id: string }).id,
        error,
      });
    });
  }

  return {
    threadId,
    status: "ESCALATED",
    activeChannel: "HUMAN",
    currentNodeId: null,
    messages: turn.messages,
    actions: turn.actions,
    escalated: true,
    resolved: false,
    supportTicketId: ticketId,
    reason: effectiveReason,
  };
}
