import { z } from "zod";
import {
  Prisma,
  SupportCaseStatus,
  type UserRole,
  type SupportCase,
} from "@prisma/client";
import { SupportIssueTypeEnum } from "@/schemas/enums";
import { callbackPhoneSchema } from "@/lib/validation/phone";
import { stageBell } from "@/lib/novu/stage-bell";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type Tx,
} from "@/lib/prisma";
import { caseKeyOf } from "./case-key";
import { stage as stageEmail } from "@/lib/email/deliver";
import { getAppUrl } from "@/lib/url";
import { DEFAULT_FROM_ADDRESS } from "@/lib/email/config";
import { canCorrespondOnCase, caseCorrespondentIds } from "./case-access";
import { supportDeadline } from "./deadline-policy";
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

export const CALLBACK_WINDOWS = [
  "09:00-12:00 IST",
  "12:00-15:00 IST",
  "15:00-18:00 IST",
  "18:00-21:00 IST",
] as const;

export const CallbackWindowSchema = z.enum(CALLBACK_WINDOWS);

export class SupportCaseValidationError extends Error {
  readonly status = 400 as const;
  readonly code = "VALIDATION_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "SupportCaseValidationError";
  }
}

const CASE_RELATIONS_INCLUDE = {
  subjects: true,
  messages: { orderBy: { seq: "asc" }, take: -200 },
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
  initialSender: z.enum(["USER", "AGENT", "SYSTEM"]).optional(),
  initialAuthorUserId: z.string().min(1).max(64).optional(),
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
  ownershipScope: z
    .enum(["PERSONAL", "ORG_OPERATIONS", "ORG_BILLING"])
    .optional(),
  appointmentId: z.string().min(1).max(64).nullable().optional(),
  appointmentOccurrenceId: z.string().min(1).max(64).nullable().optional(),
  callbackPhone: callbackPhoneSchema.nullish(),
  callbackWindow: CallbackWindowSchema.nullish(),
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

function caseScopeKey(input: CreateSupportCaseInput): string {
  if (input.appointmentOccurrenceId)
    return `OCCURRENCE:${input.appointmentOccurrenceId}`;
  if (input.appointmentId) return `APPOINTMENT:${input.appointmentId}`;
  const primary = input.subjects?.find((subject) => subject.isPrimary);
  return primary ? `${primary.subjectType}:${primary.subjectId}` : "ACCOUNT";
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
  existingOpen: { id: string },
  input: CreateSupportCaseInput,
  now: Date,
) {
  const result = await executeAppendTurnTx(
    tx,
    {
      caseId: existingOpen.id,
      authorUserId: input.initialAuthorUserId ?? input.submitterUserId,
      sender: input.initialSender ?? "USER",
      body: input.description,
      isInternal: false,
      clientTurnId: input.clientIntakeId,
    },
    now,
  );
  if (!result.ok) throw new SupportCaseValidationError(result.error);
  let refreshed = await tx.supportCase.findUniqueOrThrow({
    where: { id: existingOpen.id },
    include: CASE_RELATIONS_INCLUDE,
  });
  if (input.activeChannel === "HUMAN" && refreshed.activeChannel !== "HUMAN") {
    const priority = input.priority ?? refreshed.priority;
    const handoff = await tx.supportCase.updateMany({
      where: {
        id: refreshed.id,
        updatedAt: refreshed.updatedAt,
        activeChannel: refreshed.activeChannel,
        closedAt: null,
      },
      data: {
        activeChannel: "HUMAN",
        status: refreshed.assignedToId ? "IN_PROGRESS" : "OPEN",
        priority,
        receivedAt: now,
        ...slaDeadlinesFor(priority, now),
        ...supportDeadline(input.category, now),
      },
    });
    if (!handoff.count)
      throw new SupportCaseValidationError(
        "The case changed during handoff. Refresh and retry.",
      );
    refreshed = await tx.supportCase.findUniqueOrThrow({
      where: { id: existingOpen.id },
      include: CASE_RELATIONS_INCLUDE,
    });
    await stageSupportCaseIntakeTx(tx, refreshed, input.initialSender);
  }
  return refreshed;
}

async function validateProblemCaseTargetTx(
  tx: Tx,
  problemCaseId: string,
  currentCaseId?: string,
): Promise<boolean> {
  const target = await tx.supportCase.findUnique({
    where: { id: problemCaseId },
    select: { id: true, caseKind: true, deletedAt: true },
  });
  return (
    target?.deletedAt === null &&
    target.caseKind === "PROBLEM" &&
    target.id !== currentCaseId
  );
}

async function executeCreateOrReuseCaseTx(
  tx: Tx,
  input: CreateSupportCaseInput,
  now: Date,
) {
  if (input.problemCaseId !== undefined && input.problemCaseId !== null) {
    const validProblem = await validateProblemCaseTargetTx(
      tx,
      input.problemCaseId,
    );
    if (!validProblem) {
      throw new SupportCaseValidationError(
        "problemCaseId must reference an active PROBLEM case.",
      );
    }
  }

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
      organizationId: input.organizationId ?? null,
      ownershipScope: input.ownershipScope ?? "PERSONAL",
      scopeKey: caseScopeKey(input),
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
  const { ackDueAt, resolutionDueAt } =
    input.activeChannel === "HUMAN"
      ? slaDeadlinesFor(priority, now)
      : { ackDueAt: null, resolutionDueAt: null };
  const caseKind = input.caseKind ?? "INCIDENT";
  const problemCaseId =
    caseKind === "PROBLEM" ? null : (input.problemCaseId ?? null);

  const created = await tx.supportCase.create({
    data: {
      referenceNumber,
      clientIntakeId: input.clientIntakeId ?? null,
      ownershipScope: input.ownershipScope ?? "PERSONAL",
      scopeKey: caseScopeKey(input),
      ...(input.activeChannel === "HUMAN"
        ? { ...supportDeadline(input.category, now), receivedAt: now }
        : {}),
      title: input.title,
      description: input.description,
      category: input.category ?? null,
      flowKey: input.flowKey ?? null,
      currentNodeId: input.currentNodeId ?? null,
      activeChannel: input.activeChannel ?? "SELF_SERVE",
      issueType: input.issueType ?? null,
      priority,
      status: input.initialSender === "AGENT" ? "IN_PROGRESS" : "OPEN",
      ...(input.initialSender === "AGENT"
        ? {
            assignedToId: input.initialAuthorUserId,
            acknowledgedAt: now,
            firstAgentReplyAt: now,
            awaitingUserSince: now,
          }
        : {}),
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
            sender: input.initialSender ?? "USER",
            body: input.description,
            isInternal: false,
            clientTurnId: input.clientIntakeId ?? null,
            authorUserId:
              input.initialSender === "SYSTEM"
                ? null
                : (input.initialAuthorUserId ?? input.submitterUserId),
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

  await stageSupportCaseIntakeTx(tx, created, input.initialSender);
  return {
    supportCase: created,
    reused: false,
    dedupeReason: null,
  };
}

/** Stage formal intake notifications in the same transaction as its first human handoff. */
export async function stageSupportCaseIntakeTx(
  tx: Tx,
  created: Pick<
    SupportCase,
    | "id"
    | "referenceNumber"
    | "title"
    | "description"
    | "activeChannel"
    | "submitterUserId"
    | "organizationId"
    | "ownershipScope"
    | "externalRequesterEmail"
  >,
  initialSender?: "USER" | "AGENT" | "SYSTEM",
) {
  if (created.activeChannel === "HUMAN") {
    const operators = await tx.user.findMany({
      where: { role: { in: ["STAFF", "ADMIN"] }, banned: false },
      select: { id: true },
    });
    const href = supportRequestHref(
      caseKeyOf({ kind: "case", id: created.id }),
      created.organizationId,
    );
    await stageBell(tx, {
      workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_CREATED,
      recipients: operators.map((operator) => operator.id),
      dedupeKey: `case-created:${created.id}:staff`,
      entityRef: `case-created:${created.id}`,
      payload: {
        ticketId: created.id,
        reference: created.referenceNumber,
        ticketTitle: created.title,
        dashboardUrl: href,
        ...notificationScope(created.organizationId),
      },
    });
    if (initialSender !== "SYSTEM") {
      const correspondentIds = await caseCorrespondentIds(created, tx);
      await stageBell(tx, {
        workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
        recipients: correspondentIds,
        dedupeKey: `case-created:${created.id}:customer`,
        entityRef: `case-created:${created.id}`,
        payload: {
          ticketId: created.id,
          reference: created.referenceNumber,
          ticketTitle: created.title,
          status:
            initialSender === "AGENT"
              ? "New support message"
              : "Request received",
          dashboardUrl: href,
          ...notificationScope(created.organizationId),
        },
      });
      const recipients = await tx.user.findMany({
        where: { id: { in: correspondentIds } },
        select: { email: true },
      });
      for (const recipient of recipients) {
        const text = `Reference: ${created.referenceNumber}\n\n${created.ownershipScope === "PERSONAL" ? created.description : "An organization support request was received."}\n\n${getAppUrl()}${href}`;
        const html = text
          .replace(
            /[&<>"']/g,
            (character) =>
              ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
              })[character] ?? character,
          )
          .replace(/\n/g, "<br>");
        await stageEmail(
          {
            from: DEFAULT_FROM_ADDRESS,
            to: recipient.email,
            subject: `Support request — ${created.referenceNumber}`,
            html,
            text,
          },
          "SUPPORT_TICKET_RECEIVED",
          { tx, entityRef: `case-created:${created.id}` },
        );
      }
    }
  }
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
      organizationId: input.organizationId ?? null,
      ownershipScope: input.ownershipScope ?? "PERSONAL",
      scopeKey: caseScopeKey(input),
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
      if (recovered?.dedupeReason === "open_scope") {
        const supportCase = await prisma.$transaction((tx) =>
          appendOpenScopeTurn(tx, { id: recovered.supportCase.id }, input, now),
        );
        return { ...recovered, supportCase };
      }
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
    take: 200,
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
  if ((moved?.count ?? 0) === 0) return false;

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
  const expectedDate = input.expectedLastMessageAt
    ? new Date(input.expectedLastMessageAt)
    : undefined;

  const moved = await tx.supportCase.updateMany({
    where: {
      id: input.caseId,
      status: existingCase.status,
      updatedAt: existingCase.updatedAt,
      awaitingUserSince: existingCase.awaitingUserSince,
      ...(expectedDate
        ? {
            OR: [
              { lastMessageAt: null },
              { lastMessageAt: { lte: expectedDate } },
            ],
          }
        : {}),
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
  return (moved?.count ?? 0) > 0;
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

  const applied = await applyTurnStateUpdate(tx, existingCase, input, now);
  if (!applied) {
    if (
      input.sender === "AGENT" &&
      !input.isInternal &&
      input.expectedLastMessageAt
    ) {
      const expectedDate = new Date(input.expectedLastMessageAt);
      const latestRow = await tx.supportCase.findUnique({
        where: { id: input.caseId },
        select: { lastMessageAt: true },
      });
      const latestLastMessageAt =
        latestRow?.lastMessageAt ?? existingCase.lastMessageAt;
      if (
        latestLastMessageAt &&
        latestLastMessageAt.getTime() > expectedDate.getTime()
      ) {
        return {
          ok: false as const,
          status: 409 as const,
          code: "NEW_CUSTOMER_MESSAGE" as const,
          error:
            "Customer replied since you opened this case. Review their message before sending.",
        };
      }
    }
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

  if (
    !input.isInternal &&
    (input.sender === "USER" || input.sender === "AGENT")
  ) {
    if (input.sender === "AGENT" && existingCase.externalRequesterEmail) {
      const html = input.body.replace(
        /[&<>"']/g,
        (character) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[character] ?? character,
      );
      await stageEmail(
        {
          from: DEFAULT_FROM_ADDRESS,
          to: existingCase.externalRequesterEmail,
          subject: `Support response — ${existingCase.referenceNumber}`,
          text: input.body,
          html: `<p>${html.replace(/\n/g, "<br>")}</p><p>Reference: ${existingCase.referenceNumber}</p>`,
        },
        "SUPPORT_TICKET_RESPONSE",
        { tx, entityRef: `case-message:${created.id}` },
      );
    } else {
      const recipients =
        input.sender === "AGENT"
          ? await caseCorrespondentIds(existingCase, tx)
          : existingCase.assignedToId
            ? [existingCase.assignedToId]
            : (
                await tx.user.findMany({
                  where: { role: { in: ["STAFF", "ADMIN"] }, banned: false },
                  select: { id: true },
                })
              ).map((operator) => operator.id);
      await stageBell(tx, {
        workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
        recipients,
        dedupeKey: `case-message:${created.id}`,
        entityRef: `case-message:${created.id}`,
        payload: {
          ticketId: existingCase.id,
          reference: existingCase.referenceNumber,
          ticketTitle: existingCase.title,
          status: "New response",
          dashboardUrl: supportRequestHref(
            caseKeyOf({ kind: "case", id: existingCase.id }),
            existingCase.organizationId,
          ),
          ...notificationScope(existingCase.organizationId),
        },
      });
      if (input.sender === "AGENT") {
        const customers = await tx.user.findMany({
          where: { id: { in: recipients } },
          select: { email: true },
        });
        const href = `${getAppUrl()}${supportRequestHref(caseKeyOf({ kind: "case", id: existingCase.id }), existingCase.organizationId)}`;
        const text = `Reference: ${existingCase.referenceNumber}\n\n${existingCase.ownershipScope === "PERSONAL" ? input.body : "A new response is available in your organization support workspace."}\n\n${href}`;
        const html = text
          .replace(
            /[&<>"']/g,
            (character) =>
              ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
              })[character] ?? character,
          )
          .replace(/\n/g, "<br>");
        for (const customer of customers)
          await stageEmail(
            {
              from: DEFAULT_FROM_ADDRESS,
              to: customer.email,
              subject: `Support response — ${existingCase.referenceNumber}`,
              html,
              text,
            },
            "SUPPORT_TICKET_RESPONSE",
            { tx, entityRef: `case-message:${created.id}` },
          );
      }
    }
  }
  return {
    ok: true as const,
    replayed: false,
    messages: [created],
  };
}

/** Append a message turn idempotently via clientTurnId and advance SLA/status via CAS. */
export async function appendSupportCaseTurn(
  rawInput: AppendSupportCaseTurnInput,
  now: Date = new Date(),
) {
  const input = AppendSupportCaseTurnSchema.parse(rawInput);

  try {
    return await prisma.$transaction(
      (tx) => executeAppendTurnTx(tx, input, now),
      {
        maxWait: ALLOCATION_TX_MAX_WAIT_MS,
        timeout: ALLOCATION_TX_TIMEOUT_MS,
      },
    );
  } catch (error) {
    if (
      input.clientTurnId &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const replay = await prisma.$transaction((tx) =>
        replayClientTurnIfExists(tx, input),
      );
      if (replay) return replay;
    }
    throw error;
  }
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
  if ((movedInc?.count ?? 0) === 0) return null;

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

async function stageCaseResolutionCsatPromptTx(
  tx: Tx,
  target: {
    id: string;
    referenceNumber?: string;
    title?: string;
    submitterUserId?: string;
    requesterUserId?: string;
    externalRequesterEmail?: string | null;
    organizationId?: string | null;
  },
  resolvedAt: Date,
): Promise<void> {
  if (target.externalRequesterEmail) return;
  const current = await tx.supportCase.findUnique({ where: { id: target.id } });
  if (!current) return;
  const recipients = await caseCorrespondentIds(current, tx);
  const dedupeKey = `csat:${target.id}:${resolvedAt.toISOString()}`;
  const bellArgs = {
    workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
    recipients,
    payload: {
      ticketId: target.id,
      reference: target.referenceNumber,
      ticketTitle: target.title ?? "Support Request",
      status: "Resolved — rate your resolution",
      statusCode: "RESOLVED",
      dashboardUrl: supportRequestHref(
        caseKeyOf({ kind: "case", id: target.id }),
        target.organizationId,
      ),
      ...notificationScope(target.organizationId),
    },
    dedupeKey,
    entityRef: dedupeKey,
    notBefore: new Date(resolvedAt.getTime() + TWENTY_FOUR_HOURS_MS),
  };
  await stageBell(tx, bellArgs);
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

async function validatePatchLifecyclePreconditionsTx(
  tx: Tx,
  input: PatchSupportCaseInput,
  existing: { id: string; status: SupportCaseStatus },
) {
  if (existing.status === "CLOSED" && !input.status) {
    return {
      ok: false as const,
      status: 400 as const,
      code: "CASE_CLOSED" as const,
      error:
        "This case is closed, so assignee and priority cannot change until it is reopened.",
    };
  }

  if (input.problemCaseId !== undefined && input.problemCaseId !== null) {
    const validProblem = await validateProblemCaseTargetTx(
      tx,
      input.problemCaseId,
      existing.id,
    );
    if (!validProblem) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "VALIDATION_FAILED" as const,
        error: "problemCaseId must reference another active PROBLEM case.",
      };
    }
  }

  if (!(await validateOperatorAssigneeTx(tx, input.assignedToId))) {
    return {
      ok: false as const,
      status: 400 as const,
      code: "VALIDATION_FAILED" as const,
      error: "Assignee must be a staff or admin operator.",
    };
  }

  return null;
}

export async function executePatchLifecycleTx(
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

  if (existing.appealOfDecisionId || existing.appealOfModerationActionId) {
    const reviewerIds = new Set(
      [input.actorId, input.assignedToId].filter((id): id is string =>
        Boolean(id),
      ),
    );
    const decision = existing.appealOfDecisionId
      ? await tx.supportCaseDecision.findUnique({
          where: { id: existing.appealOfDecisionId },
          select: { decidedById: true },
        })
      : null;
    const action = existing.appealOfModerationActionId
      ? await tx.moderationAction.findUnique({
          where: { id: existing.appealOfModerationActionId },
          select: { takenById: true },
        })
      : null;
    if (
      (decision?.decidedById && reviewerIds.has(decision.decidedById)) ||
      (action?.takenById && reviewerIds.has(action.takenById))
    )
      return {
        ok: false as const,
        status: 403 as const,
        code: "INDEPENDENT_REVIEW_REQUIRED" as const,
        error: "A different eligible reviewer must handle this appeal.",
      };
  }

  const preconditionFailure = await validatePatchLifecyclePreconditionsTx(
    tx,
    input,
    existing,
  );
  if (preconditionFailure) return preconditionFailure;

  const noteTrimmed = input.note?.trim() || null;

  const updated = await tx.supportCase.updateMany({
    where: {
      id: input.caseId,
      updatedAt: new Date(input.expectedUpdatedAt),
      ...(input.status ? {} : { status: { not: "CLOSED" } }),
    },
    data: buildLifecycleUpdateData(existing, input, noteTrimmed, now),
  });

  if ((updated?.count ?? 0) === 0) {
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

  if (input.status === "RESOLVED" && existing.status !== "RESOLVED") {
    await Promise.all([
      stageCaseResolutionCsatPromptTx(tx, existing, now),
      ...cascadedIncidents.map((inc) =>
        stageCaseResolutionCsatPromptTx(tx, inc, now),
      ),
    ]);
  }

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
  viewer: {
    userId: string;
    isStaff: boolean;
    role?: UserRole | null;
    canReadPayments?: boolean;
    canReadContact?: boolean;
  },
) {
  const supportCase = await prisma.supportCase.findUnique({
    where: { id: caseId },
    include: CASE_RELATIONS_INCLUDE,
  });
  if (!supportCase || supportCase.deletedAt) {
    return null;
  }

  if (supportCase.externalRequesterEmail && !viewer.isStaff) return null;
  const isRequester = viewer.userId === supportCase.requesterUserId;
  const canCorrespond =
    viewer.isStaff ||
    (await canCorrespondOnCase(supportCase, {
      userId: viewer.userId,
      role: viewer.role ?? "CONSULTEE",
    }));
  if (!canCorrespond && !isRequester) return null;
  if (supportCase.ownershipScope !== "PERSONAL" && !canCorrespond) return null;

  if (
    !canCorrespond &&
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
      callbackPhone: viewer.canReadContact ? supportCase.callbackPhone : null,
      subjects: supportCase.subjects.filter(
        (subject) =>
          viewer.canReadPayments ||
          !["PAYMENT", "REFUND", "INVOICE"].includes(subject.subjectType),
      ),
      filedByOrganizationNotice: false as const,
    };
  }

  return {
    ...supportCase,
    messages: (supportCase.messages ?? []).filter((m) => !m.isInternal),
    assignedToId: null,
    events: (supportCase.events ?? [])
      .filter((e) =>
        ["CREATED", "STATUS_CHANGED", "REOPENED", "AUTO_CLOSED"].includes(
          e.kind,
        ),
      )
      .map((event) => ({ ...event, actorId: null, note: null })),
    filedByOrganizationNotice: false as const,
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
    return {
      ok: false as const,
      status: 404 as const,
      error: "Support case not found.",
    };
  }

  if (
    !(await canCorrespondOnCase(
      existing,
      { userId: input.userId, role: "CONSULTEE" },
      tx,
    ))
  ) {
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
export async function submitSupportCaseCsat(
  rawInput: SubmitSupportCaseCsatInput,
  now: Date = new Date(),
) {
  const input = SubmitSupportCaseCsatSchema.parse(rawInput);

  try {
    return await prisma.$transaction(
      (tx) => executeSubmitCsatTx(tx, input, now),
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
      return {
        ok: false as const,
        status: 409 as const,
        error: "This case has already been rated.",
      };
    }
    throw err;
  }
}

/** Category deadlines are absolute; monthly reporting never subtracts customer waiting time. */
export async function supportMonthlyComplianceReport(
  year: number,
  month: number,
) {
  const startUtc = new Date(Date.UTC(year, month - 1, 1) - IST_OFFSET_MS);
  const endUtc = new Date(Date.UTC(year, month, 1) - IST_OFFSET_MS);
  const rows = await prisma.supportCase.findMany({
    where: {
      receivedAt: { gte: startUtc, lt: endUtc },
      activeChannel: "HUMAN",
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      referenceNumber: true,
      category: true,
      status: true,
      createdAt: true,
      receivedAt: true,
      acknowledgedAt: true,
      resolvedAt: true,
      statutoryDueAt: true,
      appealOfDecisionId: true,
      appealOfModerationActionId: true,
    },
  });
  const cases = rows.map((row) => {
    const due =
      row.statutoryDueAt ??
      supportDeadline(row.category, row.receivedAt ?? row.createdAt)
        .statutoryDueAt;
    return {
      id: row.id,
      source: "case" as const,
      referenceNumber: row.referenceNumber,
      category: row.category,
      status: row.status,
      createdAt: row.receivedAt ?? row.createdAt,
      acknowledgedAt: row.acknowledgedAt,
      resolvedAt: row.resolvedAt,
      statutoryDueAt: due,
      acknowledgedWithin24h: Boolean(
        row.acknowledgedAt &&
        row.acknowledgedAt.getTime() -
          (row.receivedAt ?? row.createdAt).getTime() <=
          TWENTY_FOUR_HOURS_MS,
      ),
      resolvedWithinDeadline: Boolean(row.resolvedAt && row.resolvedAt <= due),
      grievance: row.category === "GRIEVANCE",
      appealed: Boolean(
        row.appealOfDecisionId || row.appealOfModerationActionId,
      ),
    };
  });
  return {
    year,
    month,
    received: cases.length,
    acknowledgedWithin24h: cases.filter((row) => row.acknowledgedWithin24h)
      .length,
    resolvedWithinDeadline: cases.filter((row) => row.resolvedWithinDeadline)
      .length,
    grievances: cases.filter((row) => row.grievance).length,
    appealed: cases.filter((row) => row.appealed).length,
    cases,
  };
}
