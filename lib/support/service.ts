/** Appointment help uses the same case and conversation as the support inbox. */

import { createHash } from "node:crypto";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type Tx,
} from "@/lib/prisma";
import type {
  SupportChannel,
  SupportThreadCategory,
  SupportCaseOwnership,
  SupportCaseStatus,
  SupportCase,
  SupportPriority,
} from "@prisma/client";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { isUniqueViolation } from "@/lib/db/pg-errors";
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
import { supportDeadline } from "./deadline-policy";
import { escalationPriority, issueTypeForReason } from "./priority";
import {
  appendSupportCaseTurn,
  createOrReuseSupportCase,
  type CreateSupportCaseInput,
  latestCaseDecisionTx,
  openCaseConflict,
  stageSupportCaseIntakeTx,
} from "./case-service";
import { assertCaseTransition, CaseConflictError } from "./case-transitions";
import {
  SupportFlowReasonEnum,
  SupportThreadCategoryEnum,
} from "@/schemas/enums";
import { z } from "zod";
import { recordFlowOutcome } from "./deflection";
import { slaDeadlinesFor, userRepliedPatch } from "./sla";
import type { SupportAction, SupportContext, SupportTurnResult } from "./types";

export interface RunTurnInput {
  clientTurnId?: string;
  /** Chosen intent — set on the first turn (or to switch intents). */
  category?: SupportThreadCategory;
  /** A selected flowchart option id (SELF_SERVE advance). */
  chosenOptionId?: string;
  /** Free text the user typed. */
  userMessage?: string;
  /** The customer flagged this hand-off as urgent. */
  urgent?: boolean;
  /** "This didn't fix it" on a resolved human conversation. */
  reopen?: boolean;
  /** The ended session a NO_SHOW report is about; the route has checked it. Defaults to the last ended one. */
  appointmentOccurrenceId?: string;
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

  const intakeId = input.clientTurnId
    ? `appointment-${createHash("sha256").update(input.clientTurnId).digest("hex")}`
    : `appointment-${crypto.randomUUID()}`;
  const intake = {
    clientIntakeId: intakeId,
    requesterUserId: userId,
    submitterUserId: userId,
    appointmentId,
    organizationId: threadOrgId,
    ownershipScope: input.isOrgParty
      ? ("ORG_OPERATIONS" as const)
      : ("PERSONAL" as const),
    title: "Appointment support",
    description: "Appointment help requested",
    initialSender: "SYSTEM" as const,
    activeChannel: "SELF_SERVE" as const,
  } satisfies CreateSupportCaseInput;
  // A no-show report is its session's own case, never another open thread on the booking.
  const noShow = input.category === "NO_SHOW" && !input.isOrgParty;
  const noShowCtx = noShow
    ? await buildSupportContext("pending", appointmentId, userId, "NO_SHOW")
    : null;
  if (noShow && !noShowCtx) return null;
  const thread = noShowCtx
    ? (
        await createOrReuseSupportCase({
          ...intake,
          category: "NO_SHOW",
          appointmentOccurrenceId:
            input.appointmentOccurrenceId ?? noShowCtx.lastEndedOccurrenceId,
        })
      ).supportCase
    : await openBookingThread(intake, input.category);
  if (
    input.clientTurnId &&
    (await prisma.supportCaseMessage.findUnique({
      where: {
        caseId_clientTurnId: {
          caseId: thread.id,
          clientTurnId: input.clientTurnId,
        },
      },
      select: { id: true },
    }))
  )
    return replayedTurn(thread);
  const storedCategory = SupportThreadCategoryEnum.parse(
    thread.category ?? "OTHER",
  );

  // Explicit intent selection re-scopes the thread to that category's entry node.
  const ctx = noShowCtx
    ? { ...noShowCtx, threadId: thread.id }
    : await buildSupportContext(
        thread.id,
        appointmentId,
        userId,
        input.category ?? storedCategory,
      );
  if (!ctx) return null;

  // Switching intent restarts the flow at its entry node.
  let category = storedCategory;
  let currentNodeId = thread.currentNodeId;
  if (input.category) {
    category = input.category;
    currentNodeId = null;
  }
  if (input.isOrgParty && !ORG_PARTY_CATEGORIES.has(category)) {
    category = "ORG_ADMIN_DISPUTE";
    currentNodeId = null;
  }

  if (thread.activeChannel === "HUMAN") {
    return persistHumanTurn(
      thread,
      input.userMessage,
      input.clientTurnId,
      input.reopen,
    );
  }

  const flow = flowForCategory(ctx, category);
  if (!flow) {
    return escalate(
      ctx,
      thread.id,
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
      input.clientTurnId,
      thread.updatedAt,
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
      input.clientTurnId,
      thread.updatedAt,
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
        input.clientTurnId,
        thread.updatedAt,
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
      category,
      escalating,
      input.userMessage,
      decision.reason ?? "escalated",
      input.urgent,
      input.clientTurnId,
      thread.updatedAt,
    );
  }

  if (turn.unrecognized) {
    const recentMessages = await prisma.supportCaseMessage.findMany({
      where: { caseId: thread.id },
      orderBy: { seq: "desc" },
      take: 8,
      select: { sender: true, body: true, metadata: true },
    });
    if (countTrailingUnrecognizedTurns(recentMessages) >= 2) {
      return escalate(
        ctx,
        thread.id,
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
        input.clientTurnId,
        thread.updatedAt,
      );
    }
  }

  const status = turn.resolved ? "RESOLVED" : "IN_PROGRESS";
  const wroteMessages = !!input.userMessage || turn.messages.length > 0;
  let refusedStatus: SupportCaseStatus | null = null;
  const acceptance = prisma.$transaction(
    async (tx) => {
      assertCaseTransition(thread.status, status, {
        decided: await isResolvedAndDecidedTx(tx, thread),
        actor: "CUSTOMER",
      });
      // A guided turn never changes the channel, so a human case never drops back to self-serve.
      const moved = await tx.supportCase.updateMany({
        where: {
          id: thread.id,
          updatedAt: thread.updatedAt,
          deletedAt: null,
          closedAt: null,
        },
        data: {
          category,
          currentNodeId: turn.nextNodeId,
          status,
          resolvedAt: turn.resolved ? new Date() : null,
          ...(wroteMessages ? { lastMessageAt: new Date() } : {}),
        },
      });
      if (moved.count === 0) return false;
      await recordFlowReasonTx(tx, thread.id, category, turn.reason);
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
        await tx.supportCaseMessage.create({
          data: {
            caseId: thread.id,
            authorUserId: outgoing[idx].sender === "USER" ? userId : null,
            seq: ++seq,
            clientTurnId: idx === 0 ? input.clientTurnId : undefined,
            ...outgoing[idx],
          },
        });
        return stepOutgoing(idx + 1);
      }
      await stepOutgoing(0);
      return true;
    },
    { maxWait: ALLOCATION_TX_MAX_WAIT_MS, timeout: ALLOCATION_TX_TIMEOUT_MS },
  );
  const accepted = await acceptance.catch(async (error: unknown) => {
    throw await openScopeConflictOr(error, { ...thread, category }, thread.id);
  });

  if (!accepted) {
    const current = await prisma.supportCase.findUniqueOrThrow({
      where: { id: thread.id },
    });
    if (
      input.clientTurnId &&
      (await prisma.supportCaseMessage.findUnique({
        where: {
          caseId_clientTurnId: {
            caseId: thread.id,
            clientTurnId: input.clientTurnId,
          },
        },
        select: { id: true },
      }))
    )
      return replayedTurn(current);
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
    activeChannel: thread.activeChannel,
    currentNodeId: accepted ? turn.nextNodeId : thread.currentNodeId,
    messages: accepted ? turn.messages : [],
    actions: accepted ? turn.actions : [],
    escalated: false,
    resolved: accepted && turn.resolved,
    accepted,
    supportTicketId: null,
    reason: turn.reason,
    outcomeId: recorded,
  };
}

/** The newest open thread on the booking, else a new one; a new intent on a resolved human conversation starts its own. */
async function openBookingThread(
  intake: CreateSupportCaseInput & { appointmentId: string },
  category: SupportThreadCategory | undefined,
): Promise<SupportCase> {
  const previous = await prisma.supportCase.findFirst({
    where: {
      appointmentId: intake.appointmentId,
      requesterUserId: intake.requesterUserId,
      submitterUserId: intake.submitterUserId,
      organizationId: intake.organizationId,
      ownershipScope: intake.ownershipScope,
      closedAt: null,
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });
  if (
    previous &&
    !(
      category &&
      previous.activeChannel === "HUMAN" &&
      previous.status === "RESOLVED"
    )
  )
    return previous;
  const { supportCase } = await createOrReuseSupportCase({
    ...intake,
    category: category ?? "OTHER",
  });
  return supportCase;
}

/** A NO_SHOW terminal's reason, kept once by CAS from null so a later answer cannot turn a report around. */
async function recordFlowReasonTx(
  tx: Tx,
  caseId: string,
  category: SupportThreadCategory,
  reason: string | undefined,
): Promise<void> {
  const parsed = SupportFlowReasonEnum.safeParse(reason);
  if (category !== "NO_SHOW" || !parsed.success) return;
  await tx.supportCase.updateMany({
    where: { id: caseId, flowReason: null },
    data: { flowReason: parsed.data },
  });
}

/** Only a resolved case can carry a decision; open statuses skip the read. */
async function isResolvedAndDecidedTx(
  tx: Tx,
  supportCase: Pick<SupportCase, "id" | "status">,
): Promise<boolean> {
  return (
    supportCase.status === "RESOLVED" &&
    (await latestCaseDecisionTx(tx, supportCase.id)) !== null
  );
}

/** A unique violation on a category or ownership write, as the 409 naming the open case in that slot. */
async function openScopeConflictOr(
  error: unknown,
  attempted: Parameters<typeof openCaseConflict>[0],
  caseId: string,
): Promise<unknown> {
  if (!isUniqueViolation(error)) return error;
  const conflict = await openCaseConflict(attempted, caseId);
  if (!conflict) return error;
  const { status, ...body } = conflict;
  return new CaseConflictError(body, status);
}

async function allocateMessageSeq(
  tx: import("@/lib/prisma").Tx,
  caseId: string,
  count: number,
) {
  const row = await tx.supportCase.update({
    where: { id: caseId },
    data: { messageSeq: { increment: count } },
    select: { messageSeq: true },
  });
  return row.messageSeq - count;
}

function replayedTurn(thread: SupportCase): RunTurnResult {
  return {
    threadId: thread.id,
    status: thread.status,
    activeChannel: thread.activeChannel,
    currentNodeId: thread.currentNodeId,
    messages: [],
    actions: [],
    escalated: thread.activeChannel === "HUMAN",
    resolved: thread.status === "RESOLVED",
    accepted: true,
    supportTicketId: thread.activeChannel === "HUMAN" ? thread.id : null,
    replyByAt: thread.ackDueAt?.toISOString() ?? null,
  };
}

const REOPEN_REFUSALS: ReadonlySet<string> = new Set([
  "CASE_DECIDED",
  "REOPEN_WINDOW_EXPIRED",
  "REOPEN_NOT_ALLOWED",
]);

async function persistHumanTurn(
  thread: SupportCase,
  userMessage: string | undefined,
  clientTurnId?: string,
  reopen?: boolean,
): Promise<RunTurnResult> {
  const result = userMessage
    ? await appendSupportCaseTurn({
        caseId: thread.id,
        authorUserId: thread.requesterUserId,
        sender: "USER",
        body: userMessage,
        isInternal: false,
        clientTurnId,
        reopen,
      })
    : null;
  if (result && !result.ok && REOPEN_REFUSALS.has(result.code)) {
    const { ok: _ok, status, ...body } = result;
    throw new CaseConflictError(body, status);
  }
  const reopened =
    reopen === true &&
    result?.ok === true &&
    !result.replayed &&
    thread.status === "RESOLVED";
  let status: SupportCaseStatus = thread.status;
  if (reopened) status = thread.assignedToId ? "IN_PROGRESS" : "OPEN";
  return {
    threadId: thread.id,
    status,
    activeChannel: "HUMAN",
    currentNodeId: null,
    messages: [],
    actions: [],
    escalated: true,
    resolved: false,
    accepted: result?.ok ?? true,
    supportTicketId: thread.id,
    replyByAt: thread.ackDueAt?.toISOString() ?? null,
  };
}

interface EscalationTurn {
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
  chosenLabel?: string;
  promises?: ReadonlyArray<{ id: string; text: string }>;
}

function escalationDescription(
  priorTurns: ReadonlyArray<{ sender: string; body: string }>,
  turn: EscalationTurn,
  userMessage: string | undefined,
  category: SupportThreadCategory,
  reason: string,
): string {
  const priorUserSteps = priorTurns
    .filter((message) => message.sender === "USER")
    .map((message) => message.body);
  const typed = userMessage?.trim();
  return stripCallbackTags(
    escalationBrief({
      customerAsk:
        typed && !isBareHumanRequest(typed)
          ? typed
          : (priorUserSteps.findLast((body) => !isBareHumanRequest(body)) ??
            turn.chosenLabel ??
            null),
      path:
        [
          ...priorUserSteps,
          ...(turn.chosenLabel ? [turn.chosenLabel] : []),
        ].join(" → ") || null,
      botSaid:
        turn.messages.find((message) => message.sender === "BOT")?.body ??
        priorTurns.findLast((message) => message.sender === "BOT")?.body ??
        null,
      reason,
      topic: category,
      promises: turn.promises,
    }),
  );
}

function handoffPriority(
  prior: Pick<SupportCase, "activeChannel" | "priority">,
  priority: SupportPriority,
  urgent: boolean | undefined,
): SupportPriority {
  if (prior.activeChannel !== "HUMAN") return priority;
  if (urgent && ["LOW", "MEDIUM"].includes(prior.priority)) return "HIGH";
  return prior.priority;
}

/**
 * An org billing dispute moves to the billing team's queue when the filer may
 * read that queue; otherwise it stays with operations so the filer keeps sight of it.
 */
async function escalationOwnershipTx(
  tx: Tx,
  prior: Pick<SupportCase, "ownershipScope" | "organizationId">,
  userId: string,
  reason: string,
): Promise<SupportCaseOwnership> {
  if (
    reason !== "org_billing_dispute" ||
    prior.ownershipScope !== "ORG_OPERATIONS" ||
    !prior.organizationId
  )
    return prior.ownershipScope;
  const member = await tx.membership.findFirst({
    where: { userId, organizationId: prior.organizationId, status: "ACTIVE" },
    select: { role: true },
  });
  return member && hasOrgPermission(member.role, "supportCases.billing.manage")
    ? "ORG_BILLING"
    : prior.ownershipScope;
}

async function escalate(
  ctx: SupportContext,
  threadId: string,
  category: SupportThreadCategory,
  turn: EscalationTurn,
  userMessage: string | undefined,
  reason: string,
  urgent: boolean | undefined,
  clientTurnId: string | undefined,
  expectedUpdatedAt: Date,
): Promise<RunTurnResult> {
  const effectiveReason = turn.reason ?? reason;
  const priority = escalationPriority(effectiveReason, urgent);
  const now = new Date();
  let attempted: Parameters<typeof openCaseConflict>[0] | null = null;
  const handoff = prisma.$transaction(
    async (tx) => {
      const prior = await tx.supportCase.findUniqueOrThrow({
        where: { id: threadId },
      });
      if (
        clientTurnId &&
        (await tx.supportCaseMessage.findUnique({
          where: { caseId_clientTurnId: { caseId: threadId, clientTurnId } },
          select: { id: true },
        }))
      )
        return { supportCase: prior, firstHandoff: false, replayed: true };
      if (prior.closedAt || prior.deletedAt) return null;
      assertCaseTransition(prior.status, "ESCALATED", {
        decided: await isResolvedAndDecidedTx(tx, prior),
        actor: "CUSTOMER",
      });
      const ownershipScope = await escalationOwnershipTx(
        tx,
        prior,
        ctx.userId,
        effectiveReason,
      );
      attempted = { ...prior, category, ownershipScope };
      const priorTurns = (
        await tx.supportCaseMessage.findMany({
          where: { caseId: threadId, isInternal: false },
          orderBy: { seq: "desc" },
          take: 6,
        })
      ).reverse();
      const description = escalationDescription(
        priorTurns,
        turn,
        userMessage,
        category,
        effectiveReason,
      );
      const moved = await tx.supportCase.updateMany({
        where: {
          id: threadId,
          updatedAt: expectedUpdatedAt,
          closedAt: null,
          deletedAt: null,
        },
        data: {
          category,
          ownershipScope,
          status: "ESCALATED",
          activeChannel: "HUMAN",
          currentNodeId: null,
          title: `Support for ${ctx.planTitle ?? `${ctx.appointmentType.toLowerCase()} appointment`}`,
          description,
          issueType: issueTypeForReason(effectiveReason),
          priority: handoffPriority(prior, priority, urgent),
          ...(prior.activeChannel === "HUMAN"
            ? {}
            : {
                ...slaDeadlinesFor(priority, now),
                ...supportDeadline(category, now),
                receivedAt: now,
              }),
          lastMessageAt: now,
          resolvedAt: null,
          ...userRepliedPatch(prior),
        },
      });
      if (!moved.count) return null;
      await recordFlowReasonTx(tx, threadId, category, turn.reason);
      const outgoing = [
        ...[turn.chosenLabel, userMessage]
          .filter((body): body is string => Boolean(body))
          .map((body) => ({
            sender: "USER" as const,
            body,
            metadata: undefined,
          })),
        ...turn.messages.map((message) => ({
          ...message,
          sender: z
            .enum(["BOT", "SYSTEM", "USER", "AGENT"])
            .parse(message.sender),
        })),
      ];
      let seq = await allocateMessageSeq(tx, threadId, outgoing.length);
      // Sequential writes preserve allocated message order and the first turn's replay identity.
      for (const [index, message] of outgoing.entries()) {
        await tx.supportCaseMessage.create({
          data: {
            caseId: threadId,
            seq: ++seq,
            clientTurnId: index === 0 ? clientTurnId : undefined,
            sender: message.sender,
            body: message.body,
            authorUserId: message.sender === "USER" ? ctx.userId : null,
            // JSON serialization omits undefined fields before Prisma persists metadata.
            metadata:
              message.sender === "BOT" || message.sender === "SYSTEM"
                ? JSON.parse(
                    JSON.stringify({
                      ...message.metadata,
                      promises:
                        turn.promises?.map((promise) => promise.text) ?? [],
                    }),
                  )
                : undefined,
          },
        });
      }
      await tx.supportCaseEvent.create({
        data: {
          caseId: threadId,
          actorId: ctx.userId,
          kind: "STATUS_CHANGED",
          fromValue: prior.status,
          toValue: "ESCALATED",
        },
      });
      if (prior.activeChannel !== "HUMAN")
        await tx.supportCaseEvent.create({
          data: {
            caseId: threadId,
            actorId: ctx.userId,
            kind: "CHANNEL_CHANGED",
            fromValue: prior.activeChannel,
            toValue: "HUMAN",
          },
        });
      const supportCase = await tx.supportCase.findUniqueOrThrow({
        where: { id: threadId },
      });
      if (prior.activeChannel !== "HUMAN")
        await stageSupportCaseIntakeTx(tx, supportCase, "USER");
      return {
        supportCase,
        firstHandoff: prior.activeChannel !== "HUMAN",
        replayed: false,
      };
    },
    { maxWait: ALLOCATION_TX_MAX_WAIT_MS, timeout: ALLOCATION_TX_TIMEOUT_MS },
  );
  const result = await handoff.catch(async (error: unknown) => {
    throw attempted
      ? await openScopeConflictOr(error, attempted, threadId)
      : error;
  });
  if (!result) {
    return {
      threadId,
      status: "CLOSED",
      activeChannel: "HUMAN",
      currentNodeId: null,
      messages: [],
      actions: [],
      escalated: false,
      resolved: false,
      accepted: false,
      supportTicketId: threadId,
    };
  }
  const supportCase = result.supportCase;
  if (result.replayed) return replayedTurn(supportCase);
  const outcomeId = await recordFlowOutcome({
    scope: "APPOINTMENT",
    flowKey: category,
    terminalNodeId: null,
    reason: effectiveReason,
    outcome: "ESCALATED",
    userId: ctx.userId,
    organizationId: ctx.organizationId,
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
    accepted: true,
    supportTicketId: threadId,
    reason: effectiveReason,
    outcomeId,
    replyByAt: supportCase.ackDueAt?.toISOString() ?? null,
  };
}
