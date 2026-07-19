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
import type { SupportAction, SupportContext } from "./types";

export interface RunTurnInput {
  /** Chosen intent — set on the first turn (or to switch intents). */
  category?: SupportThreadCategory;
  /** A selected flowchart option id (SELF_SERVE advance). */
  chosenOptionId?: string;
  /** Free text the user typed. */
  userMessage?: string;
}

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
  if (input.category && input.category !== category) {
    category = input.category;
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

  const resolver = new FlowchartResolver(flow);
  const turn = await resolver.resolveTurn(ctx, currentNodeId, {
    chosenOptionId: input.chosenOptionId,
    userMessage: input.userMessage,
  });

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
  const status = turn.resolved ? "RESOLVED" : "IN_PROGRESS";
  await prisma.$transaction(async (tx) => {
    if (input.userMessage) {
      await tx.supportMessage.create({
        data: { threadId: thread.id, sender: "USER", body: input.userMessage },
      });
    }
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
    await tx.appointmentSupportThread.update({
      where: { id: thread.id },
      data: {
        category,
        currentNodeId: turn.nextNodeId,
        status,
        resolvedAt: turn.resolved ? new Date() : null,
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
  };
}

/** Persist a message on a thread already handed to a human. */
async function persistHumanTurn(
  threadId: string,
  supportTicketId: string | null,
  userMessage: string | undefined,
): Promise<RunTurnResult> {
  if (userMessage) {
    await prisma.supportMessage.create({
      data: { threadId, sender: "USER", body: userMessage },
    });
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
  },
  userMessage: string | undefined,
  reason: string,
): Promise<RunTurnResult> {
  const priority = reason === "high_value_refund" ? "HIGH" : "MEDIUM";

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
          description: `Escalated from per-appointment support (${category}, reason: ${reason}).`,
          priority,
          category,
          paymentId: ctx.paymentId,
        },
        select: { id: true },
      });
      linkedTicketId = ticket.id;
    }

    await tx.appointmentSupportThread.update({
      where: { id: threadId },
      data: {
        category,
        currentNodeId: null,
        status: "ESCALATED",
        activeChannel: "HUMAN",
        supportTicketId: linkedTicketId,
      },
    });
    return linkedTicketId;
  });

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
  };
}
