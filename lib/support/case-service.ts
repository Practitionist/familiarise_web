import { z } from "zod";
import { Prisma } from "@prisma/client";
import { SupportIssueTypeEnum } from "@/schemas/enums";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type Tx,
} from "@/lib/prisma";
import { allocateTicketReference } from "./reference";
import {
  openWaitSeconds,
  slaDeadlinesFor,
  tightenDeadlinesForPriorityRaise,
  userRepliedPatch,
} from "./sla";

const IST_OFFSET_MS = 330 * 60_000;
const TWENTY_EIGHT_DAYS_MS = 28 * 24 * 3_600_000;
const TWENTY_FOUR_HOURS_MS = 24 * 3_600_000;
const FIFTEEN_DAYS_MS = 15 * 24 * 3_600_000;

const CASE_RELATIONS_INCLUDE = {
  subjects: true,
  messages: { orderBy: { seq: "asc" } },
  events: { orderBy: { createdAt: "asc" } },
} as const;

export const SupportCaseStatusSchema = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "ESCALATED",
  "ON_HOLD",
  "RESOLVED",
  "CLOSED",
]);

export const SupportCaseKindSchema = z.enum(["INCIDENT", "PROBLEM"]);

export const SupportSubjectTypeSchema = z.enum([
  "APPOINTMENT",
  "OCCURRENCE",
  "PAYMENT",
  "REFUND",
  "INVOICE",
  "ORGANIZATION",
  "ACCOUNT",
]);

export const SupportPrioritySchema = z.enum([
  "LOW",
  "MEDIUM",
  "HIGH",
  "URGENT",
]);

export const SupportChannelSchema = z.enum(["SELF_SERVE", "HUMAN"]);

export const SupportIssueTypeSchema = SupportIssueTypeEnum;

export const SupportMessageSenderSchema = z.enum([
  "USER",
  "AGENT",
  "BOT",
  "SYSTEM",
]);

export function refineCreateSupportCaseInput<
  T extends {
    category?: string | null;
    flowKey?: string | null;
    appointmentId?: string | null;
    appointmentOccurrenceId?: string | null;
  },
>(data: T, ctx: z.RefinementCtx) {
  if (
    (data.category === undefined || data.category === null) &&
    (data.flowKey === undefined || data.flowKey === null)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["category"],
      message: "Either category or flowKey must be provided.",
    });
  }
  if (
    data.appointmentOccurrenceId !== undefined &&
    data.appointmentOccurrenceId !== null &&
    !data.appointmentId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["appointmentId"],
      message:
        "appointmentId is required when appointmentOccurrenceId is provided.",
    });
  }
}

export const CreateSupportCaseObjectSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(10_000),
  category: z.string().trim().max(64).nullable().optional(),
  flowKey: z.string().trim().max(64).nullable().optional(),
  currentNodeId: z.string().trim().max(64).nullable().optional(),
  activeChannel: SupportChannelSchema.optional(),
  issueType: SupportIssueTypeSchema.nullable().optional(),
  priority: SupportPrioritySchema.optional(),
  caseKind: SupportCaseKindSchema.optional(),
  problemCaseId: z.string().min(1).max(64).nullable().optional(),
  requesterUserId: z.string().min(1).max(64),
  submitterUserId: z.string().min(1).max(64),
  organizationId: z.string().min(1).max(64).nullable().optional(),
  appointmentId: z.string().min(1).max(64).nullable().optional(),
  appointmentOccurrenceId: z.string().min(1).max(64).nullable().optional(),
  callbackPhone: z.string().trim().max(32).nullable().optional(),
  callbackWindow: z.string().trim().max(64).nullable().optional(),
  clientIntakeId: z.string().trim().min(1).max(128).nullable().optional(),
  subjects: z
    .array(
      z.object({
        subjectType: SupportSubjectTypeSchema,
        subjectId: z.string().min(1).max(128),
        isPrimary: z.boolean().optional(),
      }),
    )
    .optional(),
});

export const CreateSupportCaseInputSchema =
  CreateSupportCaseObjectSchema.superRefine(refineCreateSupportCaseInput);

export type CreateSupportCaseInput = z.infer<
  typeof CreateSupportCaseInputSchema
>;

export const AppendSupportCaseTurnSchema = z.object({
  caseId: z.string().min(1).max(64),
  authorUserId: z.string().min(1).max(64).nullable().optional(),
  sender: SupportMessageSenderSchema,
  body: z.string().trim().min(1).max(10_000),
  isInternal: z.boolean().default(false),
  clientTurnId: z.string().trim().min(1).max(128).nullable().optional(),
  expectedLastMessageAt: z.string().datetime().optional(),
});

export type AppendSupportCaseTurnInput = z.infer<
  typeof AppendSupportCaseTurnSchema
>;

export const PatchSupportCaseSchema = z.object({
  caseId: z.string().min(1).max(64),
  actorId: z.string().min(1).max(64),
  expectedUpdatedAt: z.string().datetime(),
  status: SupportCaseStatusSchema.optional(),
  priority: SupportPrioritySchema.optional(),
  assignedToId: z.string().min(1).max(64).nullable().optional(),
  problemCaseId: z.string().min(1).max(64).nullable().optional(),
  note: z.string().trim().max(10_000).optional(),
  closingMessage: z.string().trim().max(10_000).optional(),
});

export type PatchSupportCaseInput = z.infer<typeof PatchSupportCaseSchema>;

export const SubmitSupportCaseCsatSchema = z.object({
  caseId: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
  rating: z.number().int().min(1).max(5),
});

export type SubmitSupportCaseCsatInput = z.infer<
  typeof SubmitSupportCaseCsatSchema
>;

function resolveReopenedUserTurnStatus(
  currentStatus: z.infer<typeof SupportCaseStatusSchema>,
  assignedToId: string | null,
): z.infer<typeof SupportCaseStatusSchema> {
  if (currentStatus === "RESOLVED" || currentStatus === "ON_HOLD") {
    return assignedToId ? "IN_PROGRESS" : "OPEN";
  }
  return currentStatus;
}

function buildInitialCaseSubjects(input: CreateSupportCaseInput) {
  const subjectMap = new Map<
    string,
    {
      subjectType: z.infer<typeof SupportSubjectTypeSchema>;
      subjectId: string;
      isPrimary: boolean;
    }
  >();
  const pushSubject = (
    subjectType: z.infer<typeof SupportSubjectTypeSchema>,
    subjectId: string,
    isPrimary: boolean,
  ) => {
    const key = `${subjectType}:${subjectId}`;
    if (!subjectMap.has(key)) {
      subjectMap.set(key, { subjectType, subjectId, isPrimary });
    }
  };

  if (input.appointmentId) {
    pushSubject(
      "APPOINTMENT",
      input.appointmentId,
      !input.appointmentOccurrenceId,
    );
  }
  if (input.appointmentOccurrenceId) {
    pushSubject("OCCURRENCE", input.appointmentOccurrenceId, true);
  }
  if (input.organizationId) {
    pushSubject("ORGANIZATION", input.organizationId, false);
  }
  for (const s of input.subjects ?? []) {
    pushSubject(s.subjectType, s.subjectId, s.isPrimary ?? false);
  }
  return [...subjectMap.values()];
}

async function appendOpenScopeTurn(
  tx: Tx,
  existingOpen: NonNullable<
    Awaited<ReturnType<typeof prisma.supportCase.findFirst>>
  > & {
    subjects: Array<unknown>;
    messages: Array<unknown>;
    events: Array<unknown>;
  },
  input: CreateSupportCaseInput,
  now: Date,
) {
  const nextStatus = resolveReopenedUserTurnStatus(
    existingOpen.status,
    existingOpen.assignedToId,
  );
  const pausePatch = userRepliedPatch(
    {
      awaitingUserSince: existingOpen.awaitingUserSince ?? null,
      pausedSeconds: existingOpen.pausedSeconds ?? 0,
    },
    now,
  );
  const nextSeq = (existingOpen.messageSeq ?? 0) + 1;

  const moved = await tx.supportCase.updateMany({
    where: {
      id: existingOpen.id,
      status: existingOpen.status,
      awaitingUserSince: existingOpen.awaitingUserSince ?? null,
      pausedSeconds: existingOpen.pausedSeconds ?? 0,
    },
    data: {
      messageSeq: { increment: 1 },
      lastMessageAt: now,
      status: nextStatus,
      resolvedAt: null,
      closedAt: null,
      ...pausePatch,
    },
  });
  if (moved.count === 0) {
    throw new Error("Support case was updated concurrently; retry intake.");
  }

  const afterIncrement = await tx.supportCase.findUnique({
    where: { id: existingOpen.id },
    select: { messageSeq: true },
  });
  const allocatedSeq = afterIncrement?.messageSeq ?? nextSeq;

  const createdTurn = await tx.supportCaseMessage.create({
    data: {
      caseId: existingOpen.id,
      seq: allocatedSeq,
      sender: "USER",
      body: input.description,
      isInternal: false,
      clientTurnId: input.clientIntakeId ?? null,
      authorUserId: input.submitterUserId,
      createdAt: now,
    },
  });

  if (existingOpen.status === "RESOLVED" || existingOpen.status === "ON_HOLD") {
    await tx.supportCaseEvent.create({
      data: {
        caseId: existingOpen.id,
        actorId: input.submitterUserId,
        kind: "REOPENED",
        fromValue: existingOpen.status,
        toValue: nextStatus,
        createdAt: now,
      },
    });
  }

  const refreshed = await tx.supportCase.findUnique({
    where: { id: existingOpen.id },
    include: CASE_RELATIONS_INCLUDE,
  });

  return (
    refreshed ?? {
      ...existingOpen,
      status: nextStatus,
      messageSeq: nextSeq,
      lastMessageAt: now,
      resolvedAt: null,
      closedAt: null,
      ...pausePatch,
      messages: [
        ...(Array.isArray(existingOpen.messages) ? existingOpen.messages : []),
        createdTurn,
      ],
    }
  );
}

async function executeCreateOrReuseCaseTx(
  tx: Tx,
  input: CreateSupportCaseInput,
  now: Date,
) {
  if (input.clientIntakeId) {
    const replayed = await tx.supportCase.findFirst({
      where: {
        clientIntakeId: input.clientIntakeId,
        submitterUserId: input.submitterUserId,
      },
      include: CASE_RELATIONS_INCLUDE,
    });
    if (replayed) {
      return {
        supportCase: replayed,
        reused: true,
        dedupeReason: "client_intake_id" as const,
      };
    }
  }

  const existingOpen = await tx.supportCase.findFirst({
    where: {
      requesterUserId: input.requesterUserId,
      submitterUserId: input.submitterUserId,
      appointmentId: input.appointmentId ?? null,
      appointmentOccurrenceId: input.appointmentOccurrenceId ?? null,
      category: input.category ?? null,
      closedAt: null,
      deletedAt: null,
    },
    include: CASE_RELATIONS_INCLUDE,
  });
  if (existingOpen) {
    const updatedOpen = await appendOpenScopeTurn(tx, existingOpen, input, now);
    return {
      supportCase: updatedOpen,
      reused: true,
      dedupeReason: "open_scope" as const,
    };
  }

  const priority = input.priority ?? "MEDIUM";
  const referenceNumber = await allocateTicketReference(tx, now);
  const { ackDueAt, resolutionDueAt } = slaDeadlinesFor(priority, now);
  const caseKind = input.caseKind ?? "INCIDENT";
  const problemCaseId =
    caseKind === "PROBLEM" ? null : (input.problemCaseId ?? null);

  const created = await tx.supportCase.create({
    data: {
      referenceNumber,
      clientIntakeId: input.clientIntakeId ?? null,
      title: input.title,
      description: input.description,
      category: input.category ?? null,
      flowKey: input.flowKey ?? null,
      currentNodeId: input.currentNodeId ?? null,
      activeChannel: input.activeChannel ?? "SELF_SERVE",
      issueType: input.issueType ?? null,
      priority,
      status: "OPEN",
      caseKind,
      problemCaseId,
      requesterUserId: input.requesterUserId,
      submitterUserId: input.submitterUserId,
      organizationId: input.organizationId ?? null,
      appointmentId: input.appointmentId ?? null,
      appointmentOccurrenceId: input.appointmentOccurrenceId ?? null,
      callbackPhone: input.callbackPhone ?? null,
      callbackWindow: input.callbackWindow ?? null,
      ackDueAt,
      resolutionDueAt,
      messageSeq: 1,
      lastMessageAt: now,
      subjects: {
        create: buildInitialCaseSubjects(input),
      },
      messages: {
        create: [
          {
            seq: 1,
            sender: "USER",
            body: input.description,
            isInternal: false,
            clientTurnId: input.clientIntakeId ?? null,
            authorUserId: input.submitterUserId,
            createdAt: now,
          },
        ],
      },
      events: {
        create: [
          {
            actorId: input.submitterUserId,
            kind: "CREATED",
            toValue: "OPEN",
            createdAt: now,
          },
        ],
      },
    },
    include: CASE_RELATIONS_INCLUDE,
  });

  return {
    supportCase: created,
    reused: false,
    dedupeReason: null,
  };
}

async function recoverFromCaseUniqueConflict(input: CreateSupportCaseInput) {
  if (input.clientIntakeId) {
    const winningIntake = await prisma.supportCase.findFirst({
      where: {
        clientIntakeId: input.clientIntakeId,
        submitterUserId: input.submitterUserId,
      },
      include: CASE_RELATIONS_INCLUDE,
    });
    if (winningIntake) {
      return {
        supportCase: winningIntake,
        reused: true,
        dedupeReason: "client_intake_id" as const,
      };
    }
  }

  const winningOpen = await prisma.supportCase.findFirst({
    where: {
      requesterUserId: input.requesterUserId,
      submitterUserId: input.submitterUserId,
      appointmentId: input.appointmentId ?? null,
      appointmentOccurrenceId: input.appointmentOccurrenceId ?? null,
      category: input.category ?? null,
      closedAt: null,
      deletedAt: null,
    },
    include: CASE_RELATIONS_INCLUDE,
  });
  if (winningOpen) {
    return {
      supportCase: winningOpen,
      reused: true,
      dedupeReason: "open_scope" as const,
    };
  }

  return null;
}

/** Create a unified support case or return an existing match via clientIntakeId or open-scope dedupe. */
export async function createOrReuseSupportCase(
  rawInput: CreateSupportCaseInput,
  now: Date = new Date(),
) {
  const input = CreateSupportCaseInputSchema.parse(rawInput);

  try {
    return await prisma.$transaction(
      (tx) => executeCreateOrReuseCaseTx(tx, input, now),
      {
        maxWait: ALLOCATION_TX_MAX_WAIT_MS,
        timeout: ALLOCATION_TX_TIMEOUT_MS,
      },
    );
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const recovered = await recoverFromCaseUniqueConflict(input);
      if (recovered) return recovered;
    }
    throw err;
  }
}

async function replayClientTurnIfExists(
  tx: Tx,
  input: AppendSupportCaseTurnInput,
) {
  if (!input.clientTurnId) return null;
  const existingTurn = await tx.supportCaseMessage.findUnique({
    where: {
      caseId_clientTurnId: {
        caseId: input.caseId,
        clientTurnId: input.clientTurnId,
      },
    },
    select: { seq: true },
  });
  if (!existingTurn) return null;

  const subsequent = await tx.supportCaseMessage.findMany({
    where: {
      caseId: input.caseId,
      seq: { gte: existingTurn.seq },
      ...(input.sender !== "AGENT" ? { isInternal: false } : {}),
    },
    orderBy: { seq: "asc" },
  });
  return {
    ok: true as const,
    replayed: true,
    messages: subsequent,
  };
}

async function advanceUserTurnState(
  tx: Tx,
  existingCase: NonNullable<
    Awaited<ReturnType<typeof prisma.supportCase.findUnique>>
  >,
  input: AppendSupportCaseTurnInput,
  now: Date,
): Promise<boolean> {
  const nextStatus = resolveReopenedUserTurnStatus(
    existingCase.status,
    existingCase.assignedToId,
  );
  const moved = await tx.supportCase.updateMany({
    where: {
      id: input.caseId,
      status: existingCase.status,
      awaitingUserSince: existingCase.awaitingUserSince,
      pausedSeconds: existingCase.pausedSeconds,
    },
    data: {
      messageSeq: { increment: 1 },
      lastMessageAt: now,
      status: nextStatus,
      resolvedAt: null,
      closedAt: null,
      ...userRepliedPatch(existingCase, now),
    },
  });
  if (moved.count === 0) return false;

  if (existingCase.status === "RESOLVED" || existingCase.status === "ON_HOLD") {
    await tx.supportCaseEvent.create({
      data: {
        caseId: input.caseId,
        actorId: input.authorUserId ?? null,
        kind: "REOPENED",
        fromValue: existingCase.status,
        toValue: nextStatus,
        createdAt: now,
      },
    });
  }
  return true;
}

async function advanceAgentPublicTurnState(
  tx: Tx,
  existingCase: NonNullable<
    Awaited<ReturnType<typeof prisma.supportCase.findUnique>>
  >,
  input: AppendSupportCaseTurnInput,
  now: Date,
): Promise<boolean> {
  const waitDelta = openWaitSeconds(existingCase, now);
  const openTransitionPatch =
    existingCase.status === "OPEN"
      ? {
          status: "IN_PROGRESS" as const,
          assignedToId: existingCase.assignedToId ?? input.authorUserId ?? null,
        }
      : {};

  const moved = await tx.supportCase.updateMany({
    where: {
      id: input.caseId,
      status: { not: "CLOSED" },
      awaitingUserSince: existingCase.awaitingUserSince,
    },
    data: {
      messageSeq: { increment: 1 },
      lastMessageAt: now,
      acknowledgedAt: existingCase.acknowledgedAt ?? now,
      firstAgentReplyAt: existingCase.firstAgentReplyAt ?? now,
      awaitingUserSince: now,
      pausedSeconds: existingCase.pausedSeconds + waitDelta,
      ...openTransitionPatch,
    },
  });
  return moved.count > 0;
}

function isStaleAgentPublicReply(
  input: AppendSupportCaseTurnInput,
  lastMessageAt: Date | null,
): boolean {
  return Boolean(
    input.sender === "AGENT" &&
    !input.isInternal &&
    input.expectedLastMessageAt &&
    lastMessageAt &&
    lastMessageAt.getTime() > new Date(input.expectedLastMessageAt).getTime(),
  );
}

async function applyTurnStateUpdate(
  tx: Tx,
  existingCase: NonNullable<
    Awaited<ReturnType<Tx["supportCase"]["findUnique"]>>
  >,
  input: AppendSupportCaseTurnInput,
  now: Date,
): Promise<boolean> {
  if (input.sender === "USER") {
    return advanceUserTurnState(tx, existingCase, input, now);
  }
  if (input.sender === "AGENT" && !input.isInternal) {
    return advanceAgentPublicTurnState(tx, existingCase, input, now);
  }
  await tx.supportCase.updateMany({
    where: { id: input.caseId },
    data: {
      messageSeq: { increment: 1 },
      ...(input.isInternal ? {} : { lastMessageAt: now }),
    },
  });
  return true;
}

async function executeAppendTurnTx(
  tx: Tx,
  input: AppendSupportCaseTurnInput,
  now: Date,
) {
  const replayed = await replayClientTurnIfExists(tx, input);
  if (replayed) return replayed;

  const existingCase = await tx.supportCase.findUnique({
    where: { id: input.caseId },
  });
  if (!existingCase) {
    return {
      ok: false as const,
      status: 404 as const,
      code: "NOT_FOUND" as const,
      error: "Support case not found.",
    };
  }

  if (existingCase.status === "CLOSED" && !input.isInternal) {
    return {
      ok: false as const,
      status: 400 as const,
      code: "CASE_CLOSED" as const,
      error: "Cannot send a public message on a closed case.",
    };
  }

  if (isStaleAgentPublicReply(input, existingCase.lastMessageAt)) {
    return {
      ok: false as const,
      status: 409 as const,
      code: "NEW_CUSTOMER_MESSAGE" as const,
      error:
        "Customer replied since you opened this case. Review their message before sending.",
    };
  }

  const applied = await applyTurnStateUpdate(tx, existingCase, input, now);
  if (!applied) {
    return {
      ok: false as const,
      status: 409 as const,
      code: "CONFLICT" as const,
      error: "Support case was updated concurrently.",
    };
  }

  const seqHolder = await tx.supportCase.findUniqueOrThrow({
    where: { id: input.caseId },
    select: { messageSeq: true },
  });

  const created = await tx.supportCaseMessage.create({
    data: {
      caseId: input.caseId,
      seq: seqHolder.messageSeq,
      sender: input.sender,
      body: input.body,
      isInternal: input.isInternal,
      clientTurnId: input.clientTurnId ?? null,
      authorUserId: input.authorUserId ?? null,
      createdAt: now,
    },
  });

  return {
    ok: true as const,
    replayed: false,
    messages: [created],
  };
}

/** Append a message turn idempotently via clientTurnId and advance SLA/status via CAS. */
export function appendSupportCaseTurn(
  rawInput: AppendSupportCaseTurnInput,
  now: Date = new Date(),
) {
  const input = AppendSupportCaseTurnSchema.parse(rawInput);

  return prisma.$transaction((tx) => executeAppendTurnTx(tx, input, now), {
    maxWait: ALLOCATION_TX_MAX_WAIT_MS,
    timeout: ALLOCATION_TX_TIMEOUT_MS,
  });
}

function buildStatusDatesPatch(
  status: z.infer<typeof SupportCaseStatusSchema> | undefined,
  existing: {
    resolvedAt: Date | null;
    awaitingUserSince: Date | null;
    pausedSeconds: number;
  },
  now: Date,
): {
  resolvedAt?: Date | null;
  closedAt?: Date | null;
  awaitingUserSince?: null;
  pausedSeconds?: number;
} {
  if (!status) return {};
  const bankedPause =
    existing.awaitingUserSince !== null ? userRepliedPatch(existing, now) : {};
  if (status === "RESOLVED") {
    return { resolvedAt: now, closedAt: null, ...bankedPause };
  }
  if (status === "CLOSED") {
    return {
      closedAt: now,
      resolvedAt: existing.resolvedAt ?? now,
      ...bankedPause,
    };
  }
  return { resolvedAt: null, closedAt: null, ...bankedPause };
}

async function recordLifecycleAuditEvents(
  tx: Tx,
  input: PatchSupportCaseInput,
  existing: {
    status: z.infer<typeof SupportCaseStatusSchema>;
    priority: z.infer<typeof SupportPrioritySchema>;
    assignedToId: string | null;
    caseKind: z.infer<typeof SupportCaseKindSchema>;
    problemCaseId: string | null;
  },
  noteTrimmed: string | null,
  now: Date,
): Promise<void> {
  const auditRows: Prisma.SupportCaseEventCreateManyInput[] = [];

  if (input.status && input.status !== existing.status) {
    const wasSettled =
      existing.status === "RESOLVED" || existing.status === "CLOSED";
    const isActiveTarget =
      input.status === "OPEN" || input.status === "IN_PROGRESS";
    auditRows.push({
      caseId: input.caseId,
      actorId: input.actorId,
      kind: wasSettled && isActiveTarget ? "REOPENED" : "STATUS_CHANGED",
      fromValue: existing.status,
      toValue: input.status,
      createdAt: now,
    });
  }

  if (input.priority && input.priority !== existing.priority) {
    auditRows.push({
      caseId: input.caseId,
      actorId: input.actorId,
      kind: "PRIORITY_CHANGED",
      fromValue: existing.priority,
      toValue: input.priority,
      createdAt: now,
    });
  }

  if (
    input.assignedToId !== undefined &&
    input.assignedToId !== existing.assignedToId
  ) {
    auditRows.push({
      caseId: input.caseId,
      actorId: input.actorId,
      kind: input.assignedToId ? "ASSIGNED" : "UNASSIGNED",
      fromValue: existing.assignedToId,
      toValue: input.assignedToId,
      note: noteTrimmed,
      createdAt: now,
    });
  }

  if (
    input.problemCaseId !== undefined &&
    existing.caseKind === "INCIDENT" &&
    input.problemCaseId !== existing.problemCaseId
  ) {
    auditRows.push({
      caseId: input.caseId,
      actorId: input.actorId,
      kind: "LINKED_PROBLEM",
      fromValue: existing.problemCaseId,
      toValue: input.problemCaseId,
      createdAt: now,
    });
  }

  async function stepAudit(index: number): Promise<void> {
    if (index >= auditRows.length) return;
    await tx.supportCaseEvent.create({ data: auditRows[index] });
    return stepAudit(index + 1);
  }
  await stepAudit(0);
}

export interface CascadedIncidentNotice {
  id: string;
  referenceNumber: string;
  title: string;
  submitterUserId: string;
  organizationId: string | null;
}

async function resolveSingleLinkedIncident(
  tx: Tx,
  inc: {
    id: string;
    referenceNumber: string;
    title: string;
    submitterUserId: string;
    organizationId: string | null;
    status: z.infer<typeof SupportCaseStatusSchema>;
    messageSeq: number;
    awaitingUserSince: Date | null;
    pausedSeconds: number;
  },
  problemRef: string,
  actorId: string,
  closingMsg: string | null,
  now: Date,
): Promise<CascadedIncidentNotice | null> {
  const bankedPause =
    inc.awaitingUserSince !== null ? userRepliedPatch(inc, now) : {};
  const movedInc = await tx.supportCase.updateMany({
    where: {
      id: inc.id,
      status: inc.status,
      messageSeq: inc.messageSeq,
      awaitingUserSince: inc.awaitingUserSince,
      pausedSeconds: inc.pausedSeconds,
    },
    data: {
      status: "RESOLVED",
      resolvedAt: now,
      closedAt: null,
      ...bankedPause,
      ...(closingMsg
        ? { messageSeq: { increment: 1 }, lastMessageAt: now }
        : {}),
    },
  });
  if (movedInc.count === 0) return null;

  if (closingMsg) {
    await tx.supportCaseMessage.create({
      data: {
        caseId: inc.id,
        seq: inc.messageSeq + 1,
        sender: "AGENT",
        body: closingMsg,
        isInternal: false,
        authorUserId: actorId,
        createdAt: now,
      },
    });
  }
  await tx.supportCaseEvent.create({
    data: {
      caseId: inc.id,
      actorId,
      kind: "STATUS_CHANGED",
      fromValue: inc.status,
      toValue: "RESOLVED",
      note: `Resolved via problem ${problemRef}`,
      createdAt: now,
    },
  });

  return {
    id: inc.id,
    referenceNumber: inc.referenceNumber,
    title: inc.title,
    submitterUserId: inc.submitterUserId,
    organizationId: inc.organizationId,
  };
}

async function cascadeProblemResolution(
  tx: Tx,
  problemCase: { id: string; referenceNumber: string },
  actorId: string,
  closingMsg: string | null,
  now: Date,
): Promise<CascadedIncidentNotice[]> {
  const openIncidents = await tx.supportCase.findMany({
    where: {
      problemCaseId: problemCase.id,
      caseKind: "INCIDENT",
      status: { notIn: ["RESOLVED", "CLOSED"] },
      deletedAt: null,
    },
    select: {
      id: true,
      referenceNumber: true,
      title: true,
      submitterUserId: true,
      organizationId: true,
      status: true,
      messageSeq: true,
      awaitingUserSince: true,
      pausedSeconds: true,
    },
  });

  async function step(
    index: number,
    acc: CascadedIncidentNotice[],
  ): Promise<CascadedIncidentNotice[]> {
    if (index >= openIncidents.length) return acc;
    const notice = await resolveSingleLinkedIncident(
      tx,
      openIncidents[index],
      problemCase.referenceNumber,
      actorId,
      closingMsg,
      now,
    );
    if (notice) acc.push(notice);
    return step(index + 1, acc);
  }
  return step(0, []);
}

async function validateOperatorAssigneeTx(
  tx: Tx,
  assignedToId: string | null | undefined,
): Promise<boolean> {
  if (assignedToId === undefined || assignedToId === null) return true;
  const user = await tx.user.findUnique({
    where: { id: assignedToId },
    select: { role: true },
  });
  return Boolean(user && (user.role === "STAFF" || user.role === "ADMIN"));
}

function buildLifecycleUpdateData(
  existing: NonNullable<Awaited<ReturnType<Tx["supportCase"]["findUnique"]>>>,
  input: PatchSupportCaseInput,
  noteTrimmed: string | null,
  now: Date,
): Prisma.SupportCaseUpdateManyMutationInput {
  const tightened =
    input.priority && input.priority !== existing.priority
      ? tightenDeadlinesForPriorityRaise(existing, input.priority, now)
      : {};
  return {
    ...(input.status ? { status: input.status } : {}),
    ...buildStatusDatesPatch(input.status, existing, now),
    ...(input.priority ? { priority: input.priority } : {}),
    ...tightened,
    ...(input.assignedToId !== undefined
      ? { assignedToId: input.assignedToId }
      : {}),
    ...(input.problemCaseId !== undefined && existing.caseKind === "INCIDENT"
      ? { problemCaseId: input.problemCaseId }
      : {}),
    ...(noteTrimmed ? { messageSeq: { increment: 1 } } : {}),
  };
}

async function executePatchLifecycleTx(
  tx: Tx,
  input: PatchSupportCaseInput,
  now: Date,
) {
  const existing = await tx.supportCase.findUnique({
    where: { id: input.caseId },
  });
  if (!existing) {
    return {
      ok: false as const,
      status: 404 as const,
      code: "NOT_FOUND" as const,
      error: "Support case not found.",
    };
  }

  if (existing.status === "CLOSED" && !input.status) {
    return {
      ok: false as const,
      status: 400 as const,
      code: "CASE_CLOSED" as const,
      error:
        "This case is closed, so assignee and priority cannot change until it is reopened.",
    };
  }

  if (!(await validateOperatorAssigneeTx(tx, input.assignedToId))) {
    return {
      ok: false as const,
      status: 400 as const,
      code: "VALIDATION_FAILED" as const,
      error: "Assignee must be a staff or admin operator.",
    };
  }

  const noteTrimmed = input.note?.trim() || null;

  const updated = await tx.supportCase.updateMany({
    where: {
      id: input.caseId,
      updatedAt: new Date(input.expectedUpdatedAt),
      ...(input.status ? {} : { status: { not: "CLOSED" } }),
    },
    data: buildLifecycleUpdateData(existing, input, noteTrimmed, now),
  });

  if (updated.count === 0) {
    return {
      ok: false as const,
      status: 409 as const,
      code: "CONFLICT" as const,
      error: "Support case was modified concurrently; please retry.",
    };
  }

  if (noteTrimmed) {
    const afterSeq = await tx.supportCase.findUniqueOrThrow({
      where: { id: input.caseId },
      select: { messageSeq: true },
    });
    await tx.supportCaseMessage.create({
      data: {
        caseId: input.caseId,
        seq: afterSeq.messageSeq,
        sender: "AGENT",
        body: noteTrimmed,
        isInternal: true,
        authorUserId: input.actorId,
        createdAt: now,
      },
    });
  }

  await recordLifecycleAuditEvents(tx, input, existing, noteTrimmed, now);

  const cascadedIncidents =
    existing.caseKind === "PROBLEM" && input.status === "RESOLVED"
      ? await cascadeProblemResolution(
          tx,
          existing,
          input.actorId,
          input.closingMessage?.trim() || null,
          now,
        )
      : [];

  const refreshed = await tx.supportCase.findUniqueOrThrow({
    where: { id: input.caseId },
    include: CASE_RELATIONS_INCLUDE,
  });

  return {
    ok: true as const,
    previousStatus: existing.status,
    supportCase: refreshed,
    cascadedIncidents,
  };
}

/** Update case status, priority, assignee, problem link, internal reassignment note, and audit log atomically. */
export function patchSupportCaseLifecycle(
  rawInput: PatchSupportCaseInput,
  now: Date = new Date(),
) {
  const input = PatchSupportCaseSchema.parse(rawInput);

  if (input.status === "ON_HOLD") {
    return Promise.resolve({
      ok: false as const,
      status: 400 as const,
      code: "STATUS_NOT_SUPPORTED" as const,
      error:
        "On hold is not supported; use Waiting on customer or leave an internal note.",
    });
  }

  return prisma.$transaction((tx) => executePatchLifecycleTx(tx, input, now), {
    maxWait: ALLOCATION_TX_MAX_WAIT_MS,
    timeout: ALLOCATION_TX_TIMEOUT_MS,
  });
}

/**
 * Enforce ADR 20 transcript redaction when requester !== submitter: an org-filed
 * case exposes safe summary fields only to the subject member and never leaks operator messages.
 */
export async function readSupportCaseForViewer(
  caseId: string,
  viewer: { userId: string; isStaff: boolean },
) {
  const supportCase = await prisma.supportCase.findUnique({
    where: { id: caseId },
    include: CASE_RELATIONS_INCLUDE,
  });
  if (!supportCase || supportCase.deletedAt) {
    return null;
  }

  const isSubmitter = viewer.userId === supportCase.submitterUserId;
  const isRequester = viewer.userId === supportCase.requesterUserId;
  if (!viewer.isStaff && !isSubmitter && !isRequester) {
    return null;
  }

  if (
    !viewer.isStaff &&
    viewer.userId === supportCase.requesterUserId &&
    supportCase.requesterUserId !== supportCase.submitterUserId
  ) {
    return {
      id: supportCase.id,
      referenceNumber: supportCase.referenceNumber,
      status: supportCase.status,
      category: supportCase.category,
      createdAt: supportCase.createdAt,
      organizationId: supportCase.organizationId,
      requesterUserId: supportCase.requesterUserId,
      submitterUserId: null,
      title: "Organization support request",
      description: "",
      messages: [],
      events: [],
      subjects: [],
      filedByOrganizationNotice: true as const,
    };
  }

  if (viewer.isStaff) {
    return {
      ...supportCase,
      filedByOrganizationNotice: false as const,
    };
  }

  return {
    ...supportCase,
    messages: (supportCase.messages ?? []).filter((m) => !m.isInternal),
    events: (supportCase.events ?? []).filter(
      (e) => e.kind !== "VISIBILITY_CHANGED",
    ),
    filedByOrganizationNotice: false as const,
  };
}

async function submitLegacyTicketCsatTx(
  tx: Tx,
  input: SubmitSupportCaseCsatInput,
  now: Date,
) {
  const legacyTicket = await tx.supportTicket.findUnique({
    where: { id: input.caseId },
  });
  if (!legacyTicket || legacyTicket.userId !== input.userId) {
    return {
      ok: false as const,
      status: 404 as const,
      error: "Support case not found.",
    };
  }
  if (legacyTicket.status !== "RESOLVED" && legacyTicket.status !== "CLOSED") {
    return {
      ok: false as const,
      status: 400 as const,
      error: "Only resolved or closed cases can be rated.",
    };
  }
  if (
    !legacyTicket.resolvedAt ||
    now.getTime() - legacyTicket.resolvedAt.getTime() > TWENTY_EIGHT_DAYS_MS
  ) {
    return {
      ok: false as const,
      status: 400 as const,
      error: "The 28-day survey window for this case has expired.",
    };
  }
  const existingEvent = await tx.supportCaseEvent.findFirst({
    where: {
      legacyTicketId: input.caseId,
      kind: "CSAT_RATED",
    },
    select: { id: true },
  });
  if (existingEvent) {
    return {
      ok: false as const,
      status: 409 as const,
      error: "This case has already been rated.",
    };
  }
  await tx.supportCaseEvent.create({
    data: {
      legacyTicketId: input.caseId,
      actorId: input.userId,
      kind: "CSAT_RATED",
      toValue: String(input.rating),
      createdAt: now,
    },
  });
  return {
    ok: true as const,
    csatRating: input.rating,
    csatAt: now,
  };
}

async function executeSubmitCsatTx(
  tx: Tx,
  input: SubmitSupportCaseCsatInput,
  now: Date,
) {
  const existing = await tx.supportCase.findUnique({
    where: { id: input.caseId },
  });
  if (!existing) {
    return submitLegacyTicketCsatTx(tx, input, now);
  }

  if (existing.submitterUserId !== input.userId) {
    return {
      ok: false as const,
      status: 404 as const,
      error: "Support case not found.",
    };
  }

  if (existing.status !== "RESOLVED" && existing.status !== "CLOSED") {
    return {
      ok: false as const,
      status: 400 as const,
      error: "Only resolved or closed cases can be rated.",
    };
  }

  if (
    !existing.resolvedAt ||
    now.getTime() - existing.resolvedAt.getTime() > TWENTY_EIGHT_DAYS_MS
  ) {
    return {
      ok: false as const,
      status: 400 as const,
      error: "The 28-day survey window for this case has expired.",
    };
  }

  const updated = await tx.supportCase.updateMany({
    where: {
      id: input.caseId,
      status: { in: ["RESOLVED", "CLOSED"] },
      csatRating: null,
    },
    data: {
      csatRating: input.rating,
      csatAt: now,
    },
  });

  if (updated.count === 0) {
    return {
      ok: false as const,
      status: 409 as const,
      error: "This case has already been rated.",
    };
  }

  await tx.supportCaseEvent.create({
    data: {
      caseId: input.caseId,
      actorId: input.userId,
      kind: "CSAT_RATED",
      toValue: String(input.rating),
      createdAt: now,
    },
  });

  return {
    ok: true as const,
    csatRating: input.rating,
    csatAt: now,
  };
}

/** Record CSAT rating (1-5) within 28 days of resolution using CAS on csatRating IS NULL. */
export function submitSupportCaseCsat(
  rawInput: SubmitSupportCaseCsatInput,
  now: Date = new Date(),
) {
  const input = SubmitSupportCaseCsatSchema.parse(rawInput);

  return prisma.$transaction((tx) => executeSubmitCsatTx(tx, input, now), {
    maxWait: ALLOCATION_TX_MAX_WAIT_MS,
    timeout: ALLOCATION_TX_TIMEOUT_MS,
  });
}

/** Statutory monthly compliance report across unified SupportCase and legacy SupportTicket for an IST month. */
export async function supportMonthlyComplianceReport(
  year: number,
  month: number,
) {
  const startUtc = new Date(
    Date.UTC(year, month - 1, 1, 0, 0, 0, 0) - IST_OFFSET_MS,
  );
  const endUtc = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0) - IST_OFFSET_MS);

  const [supportCases, legacyTickets] = await Promise.all([
    prisma.supportCase.findMany({
      where: {
        createdAt: { gte: startUtc, lt: endUtc },
        deletedAt: null,
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        referenceNumber: true,
        category: true,
        status: true,
        createdAt: true,
        acknowledgedAt: true,
        resolvedAt: true,
        pausedSeconds: true,
      },
    }),
    prisma.supportTicket.findMany({
      where: {
        createdAt: { gte: startUtc, lt: endUtc },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        referenceNumber: true,
        category: true,
        status: true,
        createdAt: true,
        acknowledgedAt: true,
        resolvedAt: true,
        pausedSeconds: true,
      },
    }),
  ]);

  const rows = [
    ...supportCases.map((c) => ({ ...c, source: "case" as const })),
    ...legacyTickets.map((t) => ({ ...t, source: "ticket" as const })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  let acknowledgedWithin24h = 0;
  let disposedWithin15d = 0;
  let appealed = 0;

  const cases = rows.map((r) => {
    const ackOk =
      r.acknowledgedAt !== null &&
      r.acknowledgedAt.getTime() - r.createdAt.getTime() <=
        TWENTY_FOUR_HOURS_MS;
    const dispOk =
      r.resolvedAt !== null &&
      r.resolvedAt.getTime() - r.createdAt.getTime() - r.pausedSeconds * 1000 <=
        FIFTEEN_DAYS_MS;
    const isAppealed =
      r.category === "GRIEVANCE" || r.category === "MODERATION_APPEAL";

    if (ackOk) acknowledgedWithin24h++;
    if (dispOk) disposedWithin15d++;
    if (isAppealed) appealed++;

    return {
      id: r.id,
      source: r.source,
      referenceNumber: r.referenceNumber,
      category: r.category,
      status: r.status,
      createdAt: r.createdAt,
      acknowledgedAt: r.acknowledgedAt,
      resolvedAt: r.resolvedAt,
      pausedSeconds: r.pausedSeconds,
      acknowledgedWithin24h: ackOk,
      disposedWithin15d: dispOk,
      appealed: isAppealed,
    };
  });

  return {
    year,
    month,
    received: rows.length,
    acknowledgedWithin24h,
    disposedWithin15d,
    appealed,
    cases,
  };
}
