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

import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import type {
  SupportChannel,
  SupportThreadCategory,
  SupportThreadStatus,
} from "@prisma/client";
import { seatOrganizationId } from "@/lib/booking/participants";
import { stripCallbackTags } from "@/lib/validation/phone";
import { buildSupportContext } from "./context";
import { flowForCategory } from "./flows";
import { UNRECOGNIZED_BODY } from "./flow-walk";
import { FlowchartResolver } from "./resolvers/flowchart-resolver";
import {
  decideEscalation,
  escalationBrief,
  isBareHumanRequest,
} from "./escalation";
import { escalationPriority, issueTypeForReason } from "./priority";
import {
  notifyRequesterOfTicket,
  notifySupportStaff,
  notifyStaffOfTicketActivity,
  raiseReusedTicketToHigh,
} from "./create-ticket";
import { allocateMessageSeq } from "./message-seq";
import { recordFlowOutcome } from "./deflection";
import { allocateTicketReference } from "./reference";
import { slaDeadlinesFor, userRepliedPatch } from "./sla";
import type { SupportAction, SupportContext, SupportTurnResult } from "./types";

export interface RunTurnInput {
  /** Chosen intent — set on the first turn (or to switch intents). */
  category?: SupportThreadCategory;
  /** A selected flowchart option id (SELF_SERVE advance). */
  chosenOptionId?: string;
  /** Free text the user typed. */
  userMessage?: string;
  /** The customer flagged this hand-off as urgent. */
  urgent?: boolean;
  /**
   * Caller reached this appointment only via the org-operator party branch.
   * Restricted to org-party categories while permitting human escalation inside them.
   */
  isOrgParty?: boolean;
}

/** The only intents an org party may raise on a member's session. */
export const ORG_PARTY_CATEGORIES: ReadonlySet<SupportThreadCategory> = new Set(
  ["ORG_ADMIN_DISPUTE", "SPONSORSHIP_BILLING"],
);

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
  accepted?: boolean;
  supportTicketId: string | null;
  /** Machine-readable escalation reason (terminal node / policy), if any. */
  reason?: string;
  /** Self-serve or escalated outcome row ID for optional rating submission. */
  outcomeId?: string | null;
  /** Committed acknowledgement SLA timestamp in ISO format, when escalated. */
  replyByAt?: string | null;
}

function isUnrecognizedBotMessage(m: {
  sender: string;
  body: string;
  metadata?: unknown;
}): boolean {
  if (m.sender !== "BOT") return false;
  if (m.body === UNRECOGNIZED_BODY) return true;
  if (
    typeof m.metadata === "object" &&
    m.metadata !== null &&
    "unrecognized" in m.metadata &&
    m.metadata.unrecognized === true
  ) {
    return true;
  }
  return false;
}

function countTrailingUnrecognizedTurns(
  newestFirstMessages: ReadonlyArray<{
    sender: string;
    body: string;
    metadata?: unknown;
  }>,
): number {
  let count = 0;
  for (const msg of newestFirstMessages) {
    if (msg.sender === "USER") continue;
    if (isUnrecognizedBotMessage(msg)) {
      count += 1;
      continue;
    }
    break;
  }
  return count;
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
    select: { id: true, appointmentType: true, organizationId: true },
  });
  if (!appt) return null;
  // Attribute group-session threads to the caller's seat organization; org-operator threads keep the host org.
  const threadOrgId = input.isOrgParty
    ? appt.organizationId
    : await seatOrganizationId(prisma, appt, userId);

  // Find-or-create keyed on (appointmentId, userId) so concurrent opens converge cleanly.
  const thread = await prisma.appointmentSupportThread.upsert({
    where: { appointmentId_userId: { appointmentId, userId } },
    create: {
      appointmentId,
      userId,
      organizationId: threadOrgId,
      category: input.category ?? "OTHER",
    },
    update: {},
  });

  // Explicit intent selection re-scopes the thread to that category's entry node.
  const ctx = await buildSupportContext(
    thread.id,
    appointmentId,
    userId,
    input.category ?? thread.category,
  );
  if (!ctx) return null;

  // Switching intent restarts the flow at its entry node.
  let category = thread.category;
  let currentNodeId = thread.currentNodeId;
  if (input.category) {
    category = input.category;
    currentNodeId = null;
  }
  const orgRequestedHuman =
    Boolean(input.isOrgParty) && input.category === "OTHER";
  if (input.isOrgParty && !ORG_PARTY_CATEGORIES.has(category)) {
    category = "ORG_ADMIN_DISPUTE";
    currentNodeId = null;
  }

  if (
    thread.activeChannel === "HUMAN" &&
    !(thread.status === "RESOLVED" && input.category)
  ) {
    return persistHumanTurn(thread, input.userMessage);
  }

  if (orgRequestedHuman) {
    return escalate(
      ctx,
      thread.id,
      thread.supportTicketId,
      "ORG_ADMIN_DISPUTE",
      {
        messages: [
          {
            sender: "SYSTEM",
            body: "Connecting you with our support team.",
          },
        ],
        nextNodeId: null,
        actions: [],
        resolved: false,
        escalate: true,
        chosenLabel: "Talk to a person",
      },
      input.userMessage,
      "org_operator_human",
      input.urgent,
    );
  }

  const flow = flowForCategory(ctx, category);
  if (!flow) {
    return escalate(
      ctx,
      thread.id,
      thread.supportTicketId,
      category,
      {
        messages: [
          { sender: "SYSTEM", body: "Connecting you with our support team." },
        ],
        nextNodeId: null,
        actions: [],
        resolved: false,
        escalate: true,
      },
      input.userMessage,
      "no_flow",
      input.urgent,
    );
  }

  if (currentNodeId && !flow.nodes[currentNodeId]) {
    currentNodeId = null;
  }

  const resolver = new FlowchartResolver(flow);
  const walked = await resolver.resolveTurn(ctx, currentNodeId, {
    chosenOptionId: input.chosenOptionId,
    userMessage: input.userMessage,
  });
  const turn: SupportTurnResult =
    input.category && !walked.chosenLabel
      ? { ...walked, chosenLabel: flow.title }
      : walked;

  if (!turn.escalate && input.chosenOptionId === "human") {
    return escalate(
      ctx,
      thread.id,
      thread.supportTicketId,
      category,
      {
        messages: [
          {
            sender: "SYSTEM",
            body: "Connecting you with our support team.",
          },
        ],
        nextNodeId: null,
        actions: [],
        resolved: false,
        escalate: true,
        chosenLabel: "Talk to a person",
      },
      input.userMessage,
      `${category.toLowerCase()}_human`,
      input.urgent,
    );
  }

  const firstMeta = turn.messages[0]?.metadata;
  const resolvedNodeId =
    typeof firstMeta === "object" &&
    firstMeta !== null &&
    "nodeId" in firstMeta &&
    typeof firstMeta.nodeId === "string"
      ? firstMeta.nodeId
      : undefined;
  if (
    category === "RECORDING_ACCESS" &&
    turn.resolved &&
    resolvedNodeId === "within" &&
    ctx.endsAt &&
    Date.now() - ctx.endsAt.getTime() > 48 * 3_600_000
  ) {
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
          chosenLabel: turn.chosenLabel,
          promises: terminal.promises,
        },
        input.userMessage,
        terminal.reason ?? "recording_missing",
        input.urgent,
      );
    }
  }

  const decision = decideEscalation(ctx, turn, input.userMessage);
  if (decision.escalate) {
    const escalating = turn.unrecognized
      ? { ...turn, messages: [], unrecognized: false }
      : turn;
    return escalate(
      ctx,
      thread.id,
      thread.supportTicketId,
      category,
      escalating,
      input.userMessage,
      decision.reason ?? "escalated",
      input.urgent,
    );
  }

  if (turn.unrecognized) {
    const recentMessages = await prisma.supportMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { seq: "desc" },
      take: 8,
      select: { sender: true, body: true, metadata: true },
    });
    if (countTrailingUnrecognizedTurns(recentMessages) >= 2) {
      return escalate(
        ctx,
        thread.id,
        thread.supportTicketId,
        category,
        {
          messages: [
            {
              sender: "SYSTEM",
              body: "Let me connect you with our support team.",
            },
          ],
          nextNodeId: null,
          actions: turn.actions,
          resolved: false,
          escalate: true,
          chosenLabel: turn.chosenLabel,
        },
        input.userMessage,
        "repeated_unrecognized",
        input.urgent,
      );
    }
  }

  const status = turn.resolved ? "RESOLVED" : "IN_PROGRESS";
  const wroteMessages = !!input.userMessage || turn.messages.length > 0;
  let refusedStatus: SupportThreadStatus | null = null;
  const accepted = await prisma.$transaction(
    async (tx) => {
      const moved = await tx.appointmentSupportThread.updateMany({
        where: { id: thread.id, status: { not: "CLOSED" } },
        data: {
          category,
          currentNodeId: turn.nextNodeId,
          status,
          activeChannel: "SELF_SERVE",
          resolvedAt: turn.resolved ? new Date() : null,
          ...(wroteMessages ? { lastMessageAt: new Date() } : {}),
        },
      });
      if (moved.count === 0) return false;
      const userSaid = input.userMessage ?? turn.chosenLabel;
      const outgoing = [
        ...(userSaid
          ? [{ sender: "USER" as const, body: userSaid, metadata: undefined }]
          : []),
        ...turn.messages.map((m) => ({
          sender: m.sender,
          body: m.body,
          metadata:
            typeof m.metadata === "object" && m.metadata !== null
              ? m.metadata
              : undefined,
        })),
      ];
      let seq = await allocateMessageSeq(tx, thread.id, outgoing.length);
      async function stepOutgoing(idx: number): Promise<void> {
        if (idx >= outgoing.length) return;
        await tx.supportMessage.create({
          data: { threadId: thread.id, seq: ++seq, ...outgoing[idx] },
        });
        return stepOutgoing(idx + 1);
      }
      await stepOutgoing(0);
      return true;
    },
    { maxWait: ALLOCATION_TX_MAX_WAIT_MS, timeout: ALLOCATION_TX_TIMEOUT_MS },
  );

  if (!accepted) {
    const current = await prisma.appointmentSupportThread.findUniqueOrThrow({
      where: { id: thread.id },
      select: { status: true },
    });
    refusedStatus = current.status;
  }

  const recorded =
    accepted && turn.resolved
      ? await recordFlowOutcome({
          scope: "APPOINTMENT",
          flowKey: category,
          terminalNodeId: resolvedNodeId ?? null,
          reason: turn.reason ?? null,
          outcome: "RESOLVED",
          userId: ctx.userId,
          organizationId: ctx.organizationId,
        })
      : null;

  return {
    threadId: thread.id,
    status: refusedStatus ?? status,
    activeChannel: "SELF_SERVE",
    currentNodeId: accepted ? turn.nextNodeId : thread.currentNodeId,
    messages: accepted ? turn.messages : [],
    actions: accepted ? turn.actions : [],
    escalated: false,
    resolved: accepted && turn.resolved,
    accepted,
    supportTicketId: thread.supportTicketId,
    reason: turn.reason,
    outcomeId: recorded,
  };
}

/** Persist a message on a thread already handed to a human. */
async function persistHumanTurn(
  thread: {
    id: string;
    status: SupportThreadStatus;
    supportTicketId: string | null;
    organizationId: string | null;
  },
  userMessage: string | undefined,
): Promise<RunTurnResult> {
  let status = thread.status;
  let messageId: string | null = null;
  let accepted = true;

  if (userMessage) {
    const written = await prisma.$transaction(
      async (tx) => {
        const moved = await tx.appointmentSupportThread.updateMany({
          where: { id: thread.id, status: { not: "CLOSED" } },
          data: {
            messageSeq: { increment: 1 },
            lastMessageAt: new Date(),
            status: "ESCALATED",
            resolvedAt: null,
          },
        });
        if (moved.count === 0) return null;
        if (thread.supportTicketId) {
          await tx.supportTicket.updateMany({
            where: { id: thread.supportTicketId, status: "RESOLVED" },
            data: { status: "OPEN", resolvedAt: null },
          });
        }

        const row = await tx.appointmentSupportThread.findUniqueOrThrow({
          where: { id: thread.id },
          select: { messageSeq: true, status: true },
        });
        const message = await tx.supportMessage.create({
          data: {
            threadId: thread.id,
            sender: "USER",
            body: userMessage,
            seq: row.messageSeq,
          },
          select: { id: true },
        });
        return { id: message.id, status: row.status };
      },
      { maxWait: ALLOCATION_TX_MAX_WAIT_MS, timeout: ALLOCATION_TX_TIMEOUT_MS },
    );

    if (!written) {
      const current = await prisma.appointmentSupportThread.findUniqueOrThrow({
        where: { id: thread.id },
        select: { status: true },
      });
      status = current.status;
      accepted = false;
    } else {
      messageId = written.id;
      status = written.status;

      if (thread.supportTicketId) {
        await resumeTicketClock(thread.supportTicketId).catch((error) => {
          console.error("support: SLA resume failed", {
            ticketId: thread.supportTicketId,
            error,
          });
        });
        await notifyStaffOfTicketActivity(
          thread.supportTicketId,
          thread.organizationId,
          messageId ?? undefined,
        ).catch((error) => {
          console.error("support: user-reply notification failed", {
            threadId: thread.id,
            error,
          });
        });
      }
    }
  }

  const ticketAck = thread.supportTicketId
    ? await prisma.supportTicket.findUnique({
        where: { id: thread.supportTicketId },
        select: { ackDueAt: true },
      })
    : null;

  return {
    threadId: thread.id,
    status,
    activeChannel: "HUMAN",
    currentNodeId: null,
    messages: [],
    actions: [],
    escalated: true,
    resolved: false,
    accepted,
    supportTicketId: thread.supportTicketId,
    replyByAt: ticketAck?.ackDueAt?.toISOString() ?? null,
  };
}

/** The ball is back with us, so the resolution clock restarts. */
async function resumeTicketClock(ticketId: string): Promise<void> {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { awaitingUserSince: true, pausedSeconds: true },
  });
  if (!ticket) return;
  const claimed = await prisma.supportTicket.updateMany({
    where: {
      id: ticketId,
      awaitingUserSince: ticket.awaitingUserSince,
      pausedSeconds: ticket.pausedSeconds,
    },
    data: { lastMessageAt: new Date(), ...userRepliedPatch(ticket) },
  });
  if (claimed.count === 0) {
    await prisma.supportTicket.update({
      where: { id: ticketId },
      data: { lastMessageAt: new Date() },
    });
  }
}

/** Hand the thread to a human: persist the exchange, create/link a SupportTicket
 *  in the existing ops queue, and flip the channel to HUMAN. */
async function escalate(
  ctx: SupportContext,
  threadId: string,
  existingTicketId: string | null,
  category: SupportThreadCategory,
  turn: {
    messages: {
      sender: string;
      body: string;
      metadata?: Record<string, unknown>;
    }[];
    nextNodeId: string | null;
    actions: SupportAction[];
    resolved: boolean;
    escalate: boolean;
    reason?: string;
    /** Label of the chip that produced this turn, recorded as the USER message. */
    chosenLabel?: string;
    promises?: ReadonlyArray<{ id: string; text: string }>;
  },
  userMessage: string | undefined,
  reason: string,
  urgent: boolean | undefined,
): Promise<RunTurnResult> {
  const effectiveReason = turn.reason ?? reason;
  const priority = escalationPriority(effectiveReason, urgent);
  const issueType = issueTypeForReason(effectiveReason);

  let createdTicket: {
    id: string;
    title: string;
    organizationId: string | null;
    referenceNumber: string | null;
    userId: string;
    ackDueAt: Date | null;
    createdAt: Date;
  } | null = null;

  const normalizeSender = (
    raw: string,
  ): "BOT" | "SYSTEM" | "USER" | "AGENT" => {
    if (raw === "SYSTEM" || raw === "USER" || raw === "AGENT") return raw;
    return "BOT";
  };

  let turnMessageId: string | undefined;
  const ticketId = await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.appointmentSupportThread.updateMany({
        where: { id: threadId, status: { not: "CLOSED" } },
        data: {
          category,
          currentNodeId: null,
          status: "ESCALATED",
          activeChannel: "HUMAN",
          lastMessageAt: new Date(),
        },
      });
      if (claimed.count === 0) return null;

      const priorTurns = (
        await tx.supportMessage.findMany({
          where: { threadId },
          orderBy: { seq: "desc" },
          take: 6,
        })
      ).reverse();

      const userSaid = [turn.chosenLabel, userMessage].filter(
        (s): s is string => !!s,
      );
      const outgoing = [
        ...userSaid.map((body) => ({
          sender: "USER" as const,
          body,
          metadata: undefined,
        })),
        ...turn.messages.map((m) => ({
          sender: normalizeSender(m.sender),
          body: m.body,
          metadata:
            typeof m.metadata === "object" && m.metadata !== null
              ? m.metadata
              : undefined,
        })),
      ];
      let seq = await allocateMessageSeq(tx, threadId, outgoing.length);
      async function stepEscalationOutgoing(idx: number): Promise<void> {
        if (idx >= outgoing.length) return;
        const stored = await tx.supportMessage.create({
          data: { threadId, seq: ++seq, ...outgoing[idx] },
          select: { id: true },
        });
        turnMessageId ??= stored.id;
        return stepEscalationOutgoing(idx + 1);
      }
      await stepEscalationOutgoing(0);

      let linkedTicketId = existingTicketId;
      if (linkedTicketId) {
        await tx.supportTicket.updateMany({
          where: { id: linkedTicketId, status: "RESOLVED" },
          data: { status: "OPEN", resolvedAt: null },
        });
        if (urgent) await raiseReusedTicketToHigh(tx, linkedTicketId);
      } else {
        const openedAt = new Date();
        const referenceNumber = await allocateTicketReference(tx, openedAt);
        const { ackDueAt, resolutionDueAt } = slaDeadlinesFor(
          priority,
          openedAt,
        );
        const priorUserSteps = priorTurns
          .filter((t) => t.sender === "USER")
          .map((t) => t.body);
        const pathSteps = [
          ...priorUserSteps,
          ...(turn.chosenLabel ? [turn.chosenLabel] : []),
        ].filter(Boolean);
        const lastBotMessage =
          turn.messages.find((m) => m.sender === "BOT")?.body ??
          priorTurns.filter((t) => t.sender === "BOT").at(-1)?.body;
        const typed = userMessage?.trim();
        const customerAsk =
          typed && !isBareHumanRequest(typed)
            ? typed
            : (priorUserSteps.filter((b) => !isBareHumanRequest(b)).at(-1) ??
              (turn.chosenLabel?.trim() || null));

        const ticket = await tx.supportTicket.create({
          data: {
            userId: ctx.userId,
            title: `Support for ${ctx.planTitle ?? `${ctx.appointmentType.toLowerCase()} appointment`}`,
            description: stripCallbackTags(
              escalationBrief({
                customerAsk,
                path: pathSteps.join(" → ") || null,
                botSaid: lastBotMessage ?? null,
                reason: effectiveReason,
                topic: category,
                promises: turn.promises,
              }),
            ),
            priority,
            referenceNumber,
            lastMessageAt: openedAt,
            ackDueAt,
            resolutionDueAt,
            category,
            issueType: issueType ?? undefined,
            paymentId: ctx.paymentId,
            organizationId: ctx.organizationId,
          },
          select: {
            id: true,
            title: true,
            organizationId: true,
            referenceNumber: true,
            userId: true,
            ackDueAt: true,
            createdAt: true,
          },
        });
        linkedTicketId = ticket.id;
        createdTicket = ticket;
      }

      await tx.appointmentSupportThread.update({
        where: { id: threadId },
        data: { supportTicketId: linkedTicketId },
      });
      return linkedTicketId;
    },
    { maxWait: ALLOCATION_TX_MAX_WAIT_MS, timeout: ALLOCATION_TX_TIMEOUT_MS },
  );

  if (ticketId === null) {
    const current = await prisma.appointmentSupportThread.findUniqueOrThrow({
      where: { id: threadId },
      select: {
        status: true,
        activeChannel: true,
        currentNodeId: true,
        supportTicketId: true,
      },
    });
    return {
      threadId,
      status: current.status,
      activeChannel: current.activeChannel,
      currentNodeId: current.currentNodeId,
      messages: [],
      actions: [],
      escalated: false,
      resolved: false,
      accepted: false,
      supportTicketId: current.supportTicketId,
      reason: effectiveReason,
    };
  }

  const recorded = await recordFlowOutcome({
    scope: "APPOINTMENT",
    flowKey: category,
    terminalNodeId: null,
    reason: effectiveReason,
    outcome: "ESCALATED",
    userId: ctx.userId,
    organizationId: ctx.organizationId,
  });

  let replyByAt: string | null = null;
  if (createdTicket) {
    const minted: {
      id: string;
      title: string;
      organizationId: string | null;
      referenceNumber: string | null;
      userId: string;
      ackDueAt: Date | null;
      createdAt: Date;
    } = createdTicket;
    replyByAt = minted.ackDueAt?.toISOString() ?? null;
    await Promise.all([
      notifySupportStaff(minted).catch((error) => {
        console.error("support: staff notification failed for escalation", {
          ticketId: minted.id,
          error,
        });
      }),
      notifyRequesterOfTicket({
        id: minted.id,
        title: minted.title,
        referenceNumber: minted.referenceNumber,
        userId: minted.userId,
        ackDueAt: minted.ackDueAt,
        createdAt: minted.createdAt,
        organizationId: minted.organizationId,
      }).catch((error) => {
        console.error("support: requester receipt failed for escalation", {
          ticketId: minted.id,
          error,
        });
      }),
    ]);
  } else {
    const existing = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { ackDueAt: true },
    });
    replyByAt = existing?.ackDueAt?.toISOString() ?? null;
    await resumeTicketClock(ticketId).catch((error) => {
      console.error("support: SLA resume failed", { ticketId, error });
    });
    await notifyStaffOfTicketActivity(
      ticketId,
      ctx.organizationId,
      turnMessageId,
      "reopened",
    ).catch((error) => {
      console.error("support: re-escalation notification failed", {
        threadId,
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
    outcomeId: recorded,
    replyByAt,
  };
}
